import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findAgentTarget, requestSocket } from "./herdr-event-bridge.mjs";
import { mergeConfig, parseYamlFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";
import { appendWorkflowEvent, readWorkflowState, startWorkflowUnlocked, withWorkflowLock } from "./workflow-state.mjs";

export function contextStartPath(context = {}) {
  return context.workspace_cwd ?? context.focused_pane_cwd ?? null;
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
  return dispatchWorkflow({
    projectRoot,
    workflow,
    workspaceId: context.workspace_id ?? env.HERDR_WORKSPACE_ID,
    request,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(`HERDR_WORKFLOWS_DISPATCH_ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
