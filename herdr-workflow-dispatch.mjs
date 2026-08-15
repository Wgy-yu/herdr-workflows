import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findAgentTarget, requestSocket } from "./herdr-event-bridge.mjs";
import { mergeConfig, parseYamlFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "./workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow, writeCallbackRequest } from "./workflow-store.mjs";
import { createDispatchEnvelope, formatDispatchMessage } from "./workflow-protocol.mjs";
import { startAgentTurn } from "./herdr-agent-adapter.mjs";

export const contextStartPath = (context = {}) => context.workspace_cwd ?? context.focused_pane_cwd ?? null;
function findProjectRoot(start) { let current = resolve(start); while (true) { if (existsSync(join(current, ".herdr", "workflows.yaml"))) return current; const parent = dirname(current); if (parent === current) return null; current = parent; } }
function loadWorkflow(root, pluginRoot, env) {
  const defaults = parseYamlFile(join(pluginRoot, "skills", "herdr-workflows", "assets", "defaults.yaml"));
  const project = parseYamlFile(join(root, ".herdr", "workflows.yaml"));
  const home = env.USERPROFILE ?? env.HOME;
  const globalPath = env.HERDR_WORKFLOWS_GLOBAL_CONFIG ?? (home ? join(home, ".config", "herdr-workflows", "config.yaml") : null);
  return mergeConfig(defaults, globalPath && existsSync(globalPath) ? parseYamlFile(globalPath) : {}, project, {}).workflow;
}
export function definitionFromWorkflowConfig(workflow) {
  const definition = loadBuiltInTemplate(workflow.template ?? "development");
  for (const [id, override] of Object.entries(workflow.roles ?? {})) {
    if (!definition.roles[id] || !override || typeof override !== "object") continue;
    const { agent: _agent, ...rest } = override;
    definition.roles[id] = { ...definition.roles[id], ...rest };
  }
  if (Array.isArray(workflow.phases)) definition.phases = structuredClone(workflow.phases);
  if (Number.isInteger(workflow.maxRework)) definition.max_rework = workflow.maxRework;
  return definition;
}
const agentRecords = (response) => { const result = response?.result ?? response; return Array.isArray(result) ? result : result?.agents ?? []; };
export async function dispatchReadyPhases(root, request, options = {}) {
  const state = readStoredWorkflow(root);
  const contract = JSON.parse(readFileSync(join(root, ".herdr", "workflow", "contract.json"), "utf8"));
  const agents = agentRecords(await request("agent.list", {}));
  const outcomes = [];
  for (const phaseId of Object.keys(state.phases).filter((id) => state.phases[id].status === "READY")) {
    const roleId = contract.phases[phaseId].role;
    const target = findAgentTarget(agents, contract.roles[roleId].agent, options.workspaceId);
    if (!target) {
      await applyStoredEvent(root, { type: "DISPATCH_FAILED", eventId: `dispatch-failed-${phaseId}-${state.runId}`, runId: state.runId, phaseId, attempt: state.phases[phaseId].attempt, role: roleId, payload: { reason: "AGENT_NOT_FOUND" } });
      outcomes.push({ phaseId, status: "BLOCKED", reason: "AGENT_NOT_FOUND" }); continue;
    }
    const envelope = createDispatchEnvelope(readStoredWorkflow(root), phaseId, contract);
    const callbackRequestFile = writeCallbackRequest(root, envelope);
    const applied = await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: envelope.eventId, runId: state.runId, phaseId, attempt: envelope.attempt, role: envelope.role, callbackTokenHash: envelope.callbackTokenHash });
    if (!applied.accepted) { try { unlinkSync(callbackRequestFile); } catch {} outcomes.push({ phaseId, status: "BLOCKED", reason: applied.error?.code }); continue; }
    const delivery = await startAgentTurn({ target, text: formatDispatchMessage(envelope), timeoutMs: options.timeoutMs }, request);
    if (delivery.status === "TURN_STARTED") await applyStoredEvent(root, { type: "TURN_STARTED", eventId: `started-${envelope.eventId}`, runId: state.runId, phaseId, attempt: envelope.attempt, role: envelope.role, inReplyTo: envelope.eventId });
    else if (delivery.status === "BLOCKED") await applyStoredEvent(root, { type: "PHASE_BLOCKED", eventId: `blocked-${envelope.eventId}`, runId: state.runId, phaseId, attempt: envelope.attempt, role: envelope.role, payload: { reason: delivery.reason } });
    outcomes.push({ phaseId, target, ...delivery });
  }
  return outcomes;
}
export async function startNativeWorkflow({ projectRoot, template = "development", definition, agents = {}, mode = "do", requestMarkdown, request, workspaceId, timeoutMs }) {
  const contract = compileWorkflowDefinition(definition ?? loadBuiltInTemplate(template), { agents });
  await startStoredWorkflow(projectRoot, contract, mode, { requestMarkdown });
  const outcomes = await dispatchReadyPhases(projectRoot, request, { workspaceId, timeoutMs });
  return { state: readStoredWorkflow(projectRoot), contract, outcomes };
}
async function main(env = process.env) {
  const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  const root = findProjectRoot(contextStartPath(context) ?? process.cwd());
  if (!root) throw new Error("当前目录不在已配置 Herdr Workflows 项目内");
  const workflow = loadWorkflow(root, env.HERDR_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url)), env);
  const configured = Object.fromEntries(Object.entries(workflow.roles ?? {}).map(([id, role]) => [id, role?.agent]).filter(([, agent]) => agent));
  const agents = { leader: workflow.leader, implementer: workflow.implementer, reviewer: workflow.reviewer, ...configured };
  const requestFile = join(root, ".herdr", "workflow-request.md");
  if (!existsSync(requestFile) || !readFileSync(requestFile, "utf8").trim()) throw new Error(`工作流请求不存在或为空：${requestFile}`);
  return startNativeWorkflow({ projectRoot: root, definition: definitionFromWorkflowConfig(workflow), agents, requestMarkdown: readFileSync(requestFile, "utf8"), mode: context.mode ?? "do", workspaceId: context.workspace_id ?? env.HERDR_WORKSPACE_ID, request: (method, params) => requestSocket(env.HERDR_SOCKET_PATH, method, params) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((value) => console.log(JSON.stringify(value))).catch((error) => { console.error(`HERDR_WORKFLOWS_DISPATCH_ERROR ${error.message}`); process.exitCode = 1; });
