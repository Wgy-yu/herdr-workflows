import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendStoredAuditEvent, applyStoredEvent, readStoredWorkflow } from "./workflow-store.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const first = (...values) => values.find((value) => typeof value === "string" && value.trim()) ?? null;
function parseJson(value) { if (value && typeof value === "object") return value; try { return JSON.parse(value ?? "{}"); } catch { return {}; } }
export function parseEvent(raw, fallback = "pane.agent_status_changed") {
  const outer = parseJson(raw); const value = { ...object(outer.payload), ...object(outer.data), ...object(outer.event), ...outer }; const pane = object(value.pane); const agent = object(value.agent); const workspace = object(value.workspace);
  return { eventName: (first(value.event_name, value.eventName, value.type, fallback) === "pane_agent_status_changed" ? "pane.agent_status_changed" : first(value.event_name, value.eventName, value.type, fallback)), paneId: first(value.pane_id, value.paneId, pane.pane_id, pane.paneId), workspaceId: first(value.workspace_id, value.workspaceId, pane.workspace_id, workspace.workspace_id, workspace.workspaceId), agent: first(value.agent_name, value.agentName, typeof value.agent === "string" ? value.agent : null, agent.name, pane.agent), status: first(value.agent_status, value.agentStatus, value.status, value.state, pane.agent_status), revision: value.state_change_seq ?? value.stateChangeSeq ?? value.revision ?? value.seq ?? pane.state_change_seq ?? pane.revision ?? null };
}
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
export function findAgentTarget(agents, name, workspaceId) { if (!Array.isArray(agents) || !name || !workspaceId) return null; return agents.find((item) => (item.workspace_id ?? item.workspaceId ?? item.pane?.workspace_id) === workspaceId && same(item.name ?? item.agent ?? item.label ?? item.agent_name ?? item.pane?.agent, name))?.pane_id ?? agents.find((item) => (item.workspace_id ?? item.workspaceId) === workspaceId && same(item.name, name))?.paneId ?? null; }
export function normalizeSocketPath(path, platform = process.platform) { return path && platform === "win32" && !path.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${path}` : path; }
export function requestSocket(path, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolvePromise, rejectPromise) => { if (!path) return rejectPromise(new Error("HERDR_SOCKET_PATH 未设置")); const id = `herdr-workflow-${Date.now()}-${Math.random()}`; const socket = createConnection({ path: normalizeSocketPath(path) }); let buffer = ""; let done = false; const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? rejectPromise(error) : resolvePromise(value); }; socket.setTimeout(timeoutMs, () => finish(new Error(`Herdr Socket 请求超时：${method}`))); socket.on("error", (error) => finish(error)); socket.on("data", (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; for (const line of lines) { try { const message = JSON.parse(line); if (message.id === id) finish(message.error ? new Error(message.error.message ?? method) : null, message); } catch {} } }); socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`)); });
}
export async function handleNativeLifecycleEvent({ projectRoot, event, request }) {
  const state = readStoredWorkflow(projectRoot); const contract = JSON.parse(readFileSync(join(projectRoot, ".herdr", "workflow", "contract.json"), "utf8"));
  const active = Object.entries(state.phases).find(([id, phase]) => ["DISPATCHED", "RUNNING"].includes(phase.status) && contract.roles[contract.phases[id].role]?.agent === event.agent);
  if (!active) { await appendStoredAuditEvent(projectRoot, { type: "LIFECYCLE_OBSERVED", status: event.status, agent: event.agent, ignored: true }); return { handled: false, reason: "phase-not-active" }; }
  const [phaseId, phase] = active; const base = { runId: state.runId, phaseId, attempt: phase.attempt, role: contract.phases[phaseId].role };
  if (event.status === "working" && phase.status === "DISPATCHED") return applyStoredEvent(projectRoot, { ...base, type: "TURN_STARTED", eventId: event.eventId, inReplyTo: phase.dispatchedEventId });
  if (event.status === "blocked") return applyStoredEvent(projectRoot, { ...base, type: "PHASE_BLOCKED", eventId: event.eventId, payload: { reason: event.reason } });
  const callbackRequired = ["idle", "done"].includes(event.status);
  const audit = await appendStoredAuditEvent(projectRoot, { ...base, type: "LIFECYCLE_OBSERVED", eventId: event.eventId, status: event.status });
  if (callbackRequired && !audit.duplicate && request && event.target) await request("agent.prompt", { target: event.target, text: `阶段 ${phaseId} 尚缺少认证 callback。请读取 .herdr/workflow/contract.json，并使用当前回合收到的关联字段调用 workflow callback Action。` });
  return { handled: true, semanticTransition: false, callbackRequired, notified: callbackRequired && !audit.duplicate && Boolean(request && event.target) };
}
function findRoot(start) { let current = resolve(start); while (true) { if (existsSync(join(current, ".herdr", "workflow", "state.json"))) return current; const parent = dirname(current); if (parent === current) return null; current = parent; } }
export async function handleEvent(options = {}) { const env = options.env ?? process.env; const event = parseEvent(env.HERDR_PLUGIN_EVENT_JSON, env.HERDR_PLUGIN_EVENT); const context = parseJson(env.HERDR_PLUGIN_CONTEXT_JSON); const root = findRoot(first(context.workspace_cwd, context.focused_pane_cwd, context.cwd) ?? process.cwd()); if (!root) return { handled: false, reason: "native-workflow-not-found" }; const request = options.request ?? ((method, params) => requestSocket(env.HERDR_SOCKET_PATH, method, params)); return handleNativeLifecycleEvent({ projectRoot: root, request, event: { ...event, target: event.paneId, eventId: `lifecycle-${event.revision ?? `${event.paneId}-${event.status}`}` } }); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) handleEvent().then((value) => console.log(JSON.stringify(value))).catch((error) => { console.error(`HERDR_WORKFLOWS_EVENT_ERROR ${error.message}`); process.exitCode = 1; });
