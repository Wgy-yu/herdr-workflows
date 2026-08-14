// Herdr Workflows 的外置事件桥接。
//
// 该文件由官方 Herdr 的插件事件钩子启动，不修改 Herdr 本体。
// Herdr 通过 HERDR_PLUGIN_EVENT_JSON 传入状态事件，桥接再通过本地 Socket API
// 查询角色并调用 agent.prompt，避免 Leader 轮询或手工转发。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mergeConfig, parseYamlFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";
import { canTransitionWorkflow, nextWorkflowStatus, readWorkflowState, transitionWorkflowUnlocked, withWorkflowLock } from "./workflow-state.mjs";

const DEFAULT_EVENT = "pane.agent_status_changed";
const ROUTABLE_STATUSES = new Set(["done", "blocked"]);

function normalizeEventName(value) {
  if (value === "pane_agent_status_changed") return DEFAULT_EVENT;
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") ?? null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function parseJson(value, fallback = {}) {
  if (isObject(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function flattenEvent(value) {
  const outer = parseJson(value);
  const nested = [outer.payload, outer.data, outer.event]
    .filter(isObject)
    .reduce((result, item) => ({ ...result, ...item }), {});
  return { ...nested, ...outer };
}

/** 将 Herdr 事件环境变量统一为桥接内部使用的形状。 */
export function parseEvent(raw, fallbackEventName = DEFAULT_EVENT) {
  const value = flattenEvent(raw);
  const pane = isObject(value.pane) ? value.pane : {};
  const agent = isObject(value.agent) ? value.agent : {};
  const workspace = isObject(value.workspace) ? value.workspace : {};
  return {
    eventName: normalizeEventName(
      firstString(value.event_name, value.eventName, value.type, fallbackEventName)
    ),
    paneId: firstString(value.pane_id, value.paneId, pane.pane_id, pane.paneId),
    workspaceId: firstString(
      value.workspace_id,
      value.workspaceId,
      pane.workspace_id,
      workspace.workspace_id,
      workspace.workspaceId
    ),
    agent: firstString(
      value.agent_name,
      value.agentName,
      typeof value.agent === "string" ? value.agent : null,
      agent.name,
      agent.agent,
      pane.agent
    ),
    status: firstString(value.agent_status, value.agentStatus, value.status, value.state, pane.agent_status),
    revision: firstValue(
      value.state_change_seq,
      value.stateChangeSeq,
      value.revision,
      value.seq,
      pane.state_change_seq,
      pane.revision
    ),
  };
}

function sameAgent(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

function roleMatches(eventAgent, roleAgent) {
  return sameAgent(eventAgent, roleAgent);
}

/** 根据状态事件决定下一位 Agent，返回 null 表示不需要转发。 */
export function routeAgentEvent(event, workflow) {
  if (!event || !workflow || !ROUTABLE_STATUSES.has(event.status)) {
    return null;
  }
  if (roleMatches(event.agent, workflow.implementer) && event.status === "done") {
    return { fromRole: "implementer", toRole: "reviewer", reason: "implementation_done" };
  }
  if (roleMatches(event.agent, workflow.reviewer) && event.status === "done") {
    return { fromRole: "reviewer", toRole: "leader", reason: "review_done" };
  }
  if (event.status === "blocked" && roleMatches(event.agent, workflow.implementer)) {
    return { fromRole: "implementer", toRole: "leader", reason: "implementation_blocked" };
  }
  if (event.status === "blocked" && roleMatches(event.agent, workflow.reviewer)) {
    return { fromRole: "reviewer", toRole: "leader", reason: "review_blocked" };
  }
  return null;
}

function roleLabel(role) {
  return { implementer: "实施者", reviewer: "审查者", leader: "Leader" }[role] ?? role;
}

/** 生成发送给目标 Agent 的短通知，正文不要求 Leader 参与转发。 */
export function buildNotification({ fromRole, toRole, reason, event, ledgerPath }) {
  const action =
    reason === "implementation_done"
      ? "请直接开始审查，不要等待 Leader 转发。"
      : reason === "review_done"
        ? "请直接读取评审单并作出最终裁决，不要等待 Codex 中间转发。"
        : "请直接处理阻塞原因并决定下一步，不要等待其他 Agent 转发。";
  return [
    "【Herdr Workflows 自动通知】",
    `${roleLabel(fromRole)}已达到 ${event.status} 状态。`,
    `当前路由：${roleLabel(fromRole)} → ${roleLabel(toRole)}。`,
    `pane=${event.paneId ?? "unknown"}，workspace=${event.workspaceId ?? "unknown"}。`,
    action,
    `共享事件记录：${ledgerPath}`,
  ].join(" ");
}

/** 只对带有 Herdr 状态序号的事件去重，避免吞掉没有序号的合法后续事件。 */
export function eventKey(event, workflowStatus = null, runId = null) {
  if (!event.workspaceId || !event.paneId || !event.status) {
    return null;
  }
  if (event?.revision !== null && event?.revision !== undefined) {
    return `${event.workspaceId}:${event.paneId}:${event.status}:${event.revision}`;
  }
  if (!event.agent || !workflowStatus || !runId) return null;
  return `${runId}:${event.workspaceId}:${event.paneId}:${event.agent}:${event.status}:${workflowStatus}`;
}

function recordFields(record) {
  const pane = isObject(record?.pane) ? record.pane : {};
  return {
    name: firstString(record?.name, record?.agent, record?.label, record?.agent_name, pane.agent),
    workspaceId: firstString(record?.workspace_id, record?.workspaceId, pane.workspace_id),
    target: firstString(
      record?.pane_id,
      record?.paneId,
      record?.target,
      pane.pane_id,
      pane.paneId
    ),
  };
}

/** 从 agent.list 的结果中取出指定工作区内的可用 Agent 目标。 */
export function findAgentTarget(agents, agentName, workspaceId) {
  if (!Array.isArray(agents) || !agentName) {
    return null;
  }
  const normalized = agents.map(recordFields).filter((record) => record.target);
  if (!workspaceId) return null;
  return normalized.find(
    (record) => record.workspaceId === workspaceId && sameAgent(record.name, agentName)
  )?.target ?? null;
}

function extractAgents(response) {
  const result = response?.result ?? response;
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result?.agents)) {
    return result.agents;
  }
  if (Array.isArray(result?.items)) {
    return result.items;
  }
  return [];
}

function extractWorkspace(response) {
  const result = response?.result ?? response;
  return result?.workspace ?? result?.item ?? result ?? {};
}

/** 对官方 Herdr 本地 NDJSON Socket API 发起单次请求。 */
export function normalizeSocketPath(socketPath, platform = process.platform) {
  if (!socketPath || platform !== "win32" || socketPath.startsWith("\\\\.\\pipe\\")) {
    return socketPath;
  }
  return `\\\\.\\pipe\\${socketPath}`;
}

export function requestSocket(socketPath, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!socketPath) {
      rejectPromise(new Error("HERDR_SOCKET_PATH 未设置"));
      return;
    }
    const id = `herdr-workflows-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const socket = createConnection({ path: normalizeSocketPath(socketPath) });
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Herdr Socket 请求超时：${method}`)));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error) {
          finish(new Error(`${method} 失败：${message.error.message ?? message.error.code ?? "unknown"}`));
        } else {
          finish(null, message);
        }
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  });
}

function parseContext(raw) {
  const value = parseJson(raw);
  const workspace = isObject(value.workspace) ? value.workspace : {};
  return {
    cwd: firstString(value.workspace_cwd, value.focused_pane_cwd, value.cwd, value.project_root, value.projectRoot, workspace.cwd, workspace.root),
    workspaceId: firstString(value.workspace_id, value.workspaceId, workspace.workspace_id, workspace.workspaceId),
  };
}

function findProjectRoot(startPath) {
  if (!startPath) return null;
  let current = resolve(startPath);
  try {
    if (!existsSync(current)) {
      current = dirname(current);
    } else if (!parse(current).ext && !existsSync(join(current, ".herdr"))) {
      // 保留目录本身；下面的循环会逐级探测 .herdr/workflows.yaml。
    }
  } catch {
    return null;
  }
  while (true) {
    if (existsSync(join(current, ".herdr", "workflows.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function defaultGlobalConfigPath(env) {
  const home = env.USERPROFILE ?? env.HOME;
  return home ? join(home, ".config", "herdr-workflows", "config.yaml") : null;
}

function loadMergedWorkflow(projectRoot, pluginRoot, env) {
  const defaultsPath = join(pluginRoot, "skills", "herdr-workflows", "assets", "defaults.yaml");
  const projectPath = join(projectRoot, ".herdr", "workflows.yaml");
  const globalPath = env.HERDR_WORKFLOWS_GLOBAL_CONFIG ?? defaultGlobalConfigPath(env);
  const defaults = parseYamlFile(defaultsPath);
  const project = parseYamlFile(projectPath);
  const global = globalPath && existsSync(globalPath) ? parseYamlFile(globalPath) : {};
  return { merged: mergeConfig(defaults, global, project, {}), projectPath };
}

function hasDeliveredEvent(ledgerPath, key) {
  if (!key || !existsSync(ledgerPath)) return false;
  try {
    return readFileSync(ledgerPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        try {
          const record = JSON.parse(line);
          return record.eventKey === key && record.delivered === true &&
            ["transition_committed", "blocked_committed"].includes(record.type);
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

function appendLedger(ledgerPath, record) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

function contextPath(context, event) {
  return firstString(context.cwd, event.cwd, event.projectRoot);
}

function eventAgentRecord(agents, paneId) {
  if (!paneId) return null;
  return agents.find((record) => recordFields(record).target === paneId) ?? null;
}

function notificationTitle(route) {
  if (route.reason === "implementation_done") return "实施完成，审查者待命";
  if (route.reason === "review_done") return "审查完成，Leader 待裁决";
  return "Herdr Agent 需要关注";
}

/** 处理一个事件钩子；返回结果便于测试和 plugin log 诊断。 */
export async function handleEvent(options = {}) {
  const env = options.env ?? process.env;
  const event = parseEvent(env.HERDR_PLUGIN_EVENT_JSON, env.HERDR_PLUGIN_EVENT ?? DEFAULT_EVENT);
  if (event.eventName !== DEFAULT_EVENT) {
    return { handled: false, reason: "unsupported-event", event };
  }

  const socketPath = env.HERDR_SOCKET_PATH;
  const request = options.request ?? ((method, params) => requestSocket(socketPath, method, params));
  const context = parseContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  event.workspaceId = event.workspaceId ?? context.workspaceId ?? env.HERDR_WORKSPACE_ID ?? null;

  let projectRoot = findProjectRoot(contextPath(context, event));
  if (!projectRoot && event.workspaceId) {
    try {
      const workspaceResponse = await request("workspace.get", { workspace_id: event.workspaceId });
      const workspace = extractWorkspace(workspaceResponse);
      projectRoot = findProjectRoot(firstString(workspace.cwd, workspace.root, workspace.path));
    } catch {
      // 没有运行中的 Herdr 或工作区已关闭时，安全地跳过，不阻塞官方事件钩子。
    }
  }
  if (!projectRoot) {
    return { handled: false, reason: "project-config-not-found", event };
  }

  let loaded;
  try {
    loaded = loadMergedWorkflow(projectRoot, env.HERDR_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url)), env);
  } catch (error) {
    return { handled: false, reason: "config-invalid", error: error.message, event };
  }
  const workflow = loaded.merged.workflow;
  if (!workflow.leader || !workflow.implementer || !workflow.reviewer) {
    return { handled: false, reason: "roles-not-configured", event };
  }

  let agents = [];
  try {
    agents = extractAgents(await request("agent.list", {}));
  } catch {
    // 事件记录仍然保留，便于用户诊断；没有 Agent 列表时无法安全地误发消息。
  }
  const sourceName = recordFields(eventAgentRecord(agents, event.paneId)).name ?? null;
  if (!event.agent || sourceName) {
    // Herdr 的事件可能报告 kind（如 opencode），而配置使用 agent.start 的自定义 name；
    // pane.agent.list 的名称优先用于角色匹配。
    event.agent = sourceName ?? event.agent;
  }
  const route = routeAgentEvent(event, workflow);
  if (!route) {
    return { handled: false, reason: "not-routable", event };
  }

  const ledgerPath = join(projectRoot, ".herdr", "workflow-events.jsonl");
  return withWorkflowLock(projectRoot, async () => {
    const workflowState = readWorkflowState(projectRoot);
    const key = eventKey(event, workflowState.status, workflowState.runId);
    if (!canTransitionWorkflow(workflowState.status, route.reason)) {
      return { handled: false, reason: "workflow-state-not-routable", error: `非法工作流迁移：${workflowState.status} + ${route.reason}`, event, route, eventKey: key, workflowState };
    }
    if (hasDeliveredEvent(ledgerPath, key)) {
      return { handled: false, reason: "duplicate-event", event, route, eventKey: key };
    }
    const targetAgent = workflow[route.toRole];
    const target = findAgentTarget(agents, targetAgent, event.workspaceId);
    const message = buildNotification({ ...route, event, ledgerPath });
    try {
      if (!target || target === event.paneId) throw new Error("当前 workspace 中找不到目标 Agent");
      await request("agent.prompt", { target, text: message });
    } catch (error) {
      appendLedger(ledgerPath, { at: new Date().toISOString(), type: "delivery_failed", eventKey: key, event, route, target, error: error.message, delivered: false, workflowStatus: workflowState.status });
      try {
        await request("notification.show", { title: notificationTitle(route), body: message, sound: "request" });
      } catch {}
      return { handled: false, reason: "delivery-failed", event, route, target, eventKey: key, workflowStatus: workflowState.status };
    }
    appendLedger(ledgerPath, { at: new Date().toISOString(), type: "transition_pending", eventKey: key, event, route, target, delivery: "agent.prompt", delivered: true, runId: workflowState.runId, fromStatus: workflowState.status, toStatus: nextWorkflowStatus(workflowState.status, route.reason) });
    let nextWorkflowState;
    try {
      nextWorkflowState = transitionWorkflowUnlocked(projectRoot, route.reason, key);
    } catch (error) {
      return { handled: false, reason: "workflow-state-not-routable", error: error.message, event, route, eventKey: key, workflowState };
    }
    appendLedger(ledgerPath, { at: new Date().toISOString(), type: route.reason.includes("blocked") ? "blocked_committed" : "transition_committed", eventKey: key, event, route, target, delivery: "agent.prompt", delivered: true, runId: nextWorkflowState.runId, workflowStatus: nextWorkflowState.status });
    return { handled: true, event, route, target, delivery: "agent.prompt", delivered: true, ledgerPath, workflowStatus: nextWorkflowState.status };
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  handleEvent()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(`HERDR_WORKFLOWS_BRIDGE_ERROR ${error.message}`);
      process.exitCode = 1;
    });
}
