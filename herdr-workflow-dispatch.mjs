import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findAgentTarget, requestSocket } from "./herdr-event-bridge.mjs";
import { mergeConfig, parseYamlFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";
import { appendWorkflowEvent, readWorkflowState, startWorkflowUnlocked, withWorkflowLock } from "./workflow-state.mjs";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "./workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow } from "./workflow-store.mjs";
import { createDispatchEnvelope, formatDispatchMessage } from "./workflow-protocol.mjs";
import { startAgentTurn } from "./herdr-agent-adapter.mjs";

export function contextStartPath(context = {}) {
  return context.workspace_cwd ?? context.focused_pane_cwd ?? null;
}

function agentRecords(response) {
  const result = response?.result ?? response;
  return Array.isArray(result) ? result : result?.agents ?? [];
}

function targetForRole(records, role, workspaceId) {
  const agent = role.agent;
  if (!agent) return null;
  return findAgentTarget(records, agent, workspaceId);
}

export async function dispatchReadyPhases(projectRoot, request, options = {}) {
  const state = readStoredWorkflow(projectRoot);
  const contract = JSON.parse(readFileSync(join(projectRoot, ".herdr", "workflow", "contract.json"), "utf8"));
  const records = agentRecords(await request("agent.list", {}));
  const ready = Object.keys(state.phases).filter((id) => state.phases[id].status === "READY");
  const outcomes = [];
  for (const phaseId of ready) {
    const definition = contract.phases[phaseId];
    const target = targetForRole(records, contract.roles[definition.role], options.workspaceId);
    if (!target) { outcomes.push({ phaseId, status: "BLOCKED", reason: "AGENT_NOT_FOUND" }); continue; }
    const envelope = createDispatchEnvelope(readStoredWorkflow(projectRoot), phaseId, contract);
    const dispatched = await applyStoredEvent(projectRoot, {
      type: "TURN_DISPATCHED", eventId: envelope.eventId, runId: state.runId, phaseId,
      attempt: envelope.attempt, role: envelope.role, callbackTokenHash: envelope.callbackTokenHash,
    });
    if (!dispatched.accepted) { outcomes.push({ phaseId, status: "BLOCKED", reason: dispatched.error?.code }); continue; }
    const delivery = await startAgentTurn({ target, text: formatDispatchMessage(envelope), timeoutMs: options.timeoutMs }, request);
    if (delivery.status === "TURN_STARTED") {
      await applyStoredEvent(projectRoot, { type: "TURN_STARTED", eventId: `started-${envelope.eventId}`, runId: state.runId, phaseId, attempt: envelope.attempt, role: envelope.role, inReplyTo: envelope.eventId });
    } else if (delivery.status === "BLOCKED") {
      await applyStoredEvent(projectRoot, { type: "PHASE_BLOCKED", eventId: `blocked-${envelope.eventId}`, runId: state.runId, phaseId, attempt: envelope.attempt, role: envelope.role, payload: { reason: delivery.reason } });
    }
    outcomes.push({ phaseId, target, ...delivery });
  }
  return outcomes;
}

export async function startNativeWorkflow({ projectRoot, template = "development", definition, agents, mode = "do", request, workspaceId, timeoutMs }) {
  const contract = compileWorkflowDefinition(definition ?? loadBuiltInTemplate(template), { agents });
  const state = await startStoredWorkflow(projectRoot, contract, mode);
  const outcomes = await dispatchReadyPhases(projectRoot, request, { workspaceId, timeoutMs });
  return { state: readStoredWorkflow(projectRoot), contract, outcomes };
}

function findProjectRoot(startPath) {
  let current = resolve(startPath);
  while (true) {
    if (existsSync(join(current, ".herdr", "workflows.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadWorkflow(projectRoot, pluginRoot, env) {
  const defaults = parseYamlFile(join(pluginRoot, "skills", "herdr-workflows", "assets", "defaults.yaml"));
  const project = parseYamlFile(join(projectRoot, ".herdr", "workflows.yaml"));
  const home = env.USERPROFILE ?? env.HOME;
  const globalPath = env.HERDR_WORKFLOWS_GLOBAL_CONFIG ??
    (home ? join(home, ".config", "herdr-workflows", "config.yaml") : null);
  const global = globalPath && existsSync(globalPath) ? parseYamlFile(globalPath) : {};
  return mergeConfig(defaults, global, project, {}).workflow;
}

export function definitionFromWorkflowConfig(workflow) {
  const definition = loadBuiltInTemplate(workflow.template ?? "development");
  for (const [roleId, override] of Object.entries(workflow.roles ?? {})) {
    if (!definition.roles[roleId] || !override || typeof override !== "object") continue;
    const { agent: _agent, ...contractOverride } = override;
    definition.roles[roleId] = { ...definition.roles[roleId], ...contractOverride };
  }
  if (Array.isArray(workflow.phases)) definition.phases = structuredClone(workflow.phases);
  if (Number.isInteger(workflow.maxRework)) definition.max_rework = workflow.maxRework;
  return definition;
}

function agentsFromWorkflow(workflow) {
  const result = Object.fromEntries(Object.entries(workflow.roles ?? {}).map(([id, role]) => [id, role?.agent]).filter(([, agent]) => agent));
  return { leader: workflow.leader, implementer: workflow.implementer, reviewer: workflow.reviewer, ...result };
}

export async function dispatchWorkflow(options) {
  const { projectRoot, workflow, request, workspaceId } = options;
  const planPath = join(projectRoot, ".herdr", "workflow-plan.md");
  if (!existsSync(planPath)) throw new Error(`共享计划不存在：${planPath}`);
  const plan = readFileSync(planPath, "utf8").trim();
  if (!plan) throw new Error(`共享计划为空：${planPath}`);

  const response = await request("agent.list", {});
  const agents = response?.result?.agents ?? response?.result ?? [];
  const target = findAgentTarget(agents, workflow.implementer, workspaceId);
  if (!target) throw new Error(`找不到实施者 Agent：${workflow.implementer}`);

  return withWorkflowLock(projectRoot, async () => {
    const current = readWorkflowState(projectRoot);
    if (!["READY", "FINAL_DECISION_PENDING", "BLOCKED"].includes(current.status)) {
      throw new Error(`当前状态不允许 dispatch：${current.status}`);
    }
    try {
      await request("agent.prompt", {
        target,
        text: `【Herdr Workflows 实施任务】 请读取共享计划并开始实施：${planPath}`,
      });
    } catch (error) {
      appendWorkflowEvent(projectRoot, { type: "dispatch_failed", status: current.status, error: error.message });
      throw new Error(`实施任务下发失败，状态保持 ${current.status}：${error.message}`);
    }
    appendWorkflowEvent(projectRoot, { type: "dispatch_pending", fromStatus: current.status, toStatus: "IMPLEMENTATION_RUNNING", target });
    const state = startWorkflowUnlocked(projectRoot, workflow.name ?? "default");
    appendWorkflowEvent(projectRoot, { type: "dispatch_committed", runId: state.runId, status: state.status, target });
    return { ...state, target, planPath };
  });
}

async function main(env = process.env) {
  const context = env.HERDR_PLUGIN_CONTEXT_JSON ? JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON) : {};
  const projectRoot = findProjectRoot(contextStartPath(context) ?? process.cwd());
  if (!projectRoot) throw new Error("当前目录不在已配置 Herdr Workflows 项目内");
  const pluginRoot = env.HERDR_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url));
  const workflow = loadWorkflow(projectRoot, pluginRoot, env);
  const request = (method, params) => requestSocket(env.HERDR_SOCKET_PATH, method, params);
  return startNativeWorkflow({ projectRoot, definition: definitionFromWorkflowConfig(workflow), agents: agentsFromWorkflow(workflow), mode: context.mode ?? "do", workspaceId: context.workspace_id ?? env.HERDR_WORKSPACE_ID, request });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(`HERDR_WORKFLOWS_DISPATCH_ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
