import { randomUUID } from "node:crypto";
import { appendStoredAuditEvent, applyStoredEvent, readStoredWorkflow, writeStageReport } from "./workflow-store.mjs";
import { validateCallbackEnvelope } from "./workflow-protocol.mjs";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { dispatchReadyPhases } from "./herdr-workflow-dispatch.mjs";
import { requestSocket } from "./herdr-event-bridge.mjs";

export async function handleCallback(options) {
  const root = options.projectRoot ?? options.workspace_cwd ?? process.cwd();
  const state = readStoredWorkflow(root);
  const contract = JSON.parse(readFileSync(join(root, ".herdr", "workflow", "contract.json"), "utf8"));
  const validation = validateCallbackEnvelope(options, state, contract);
  if (!validation.valid) {
    await appendStoredAuditEvent(root, { type: "CALLBACK_REJECTED", eventId: options.event_id ?? randomUUID(), error: validation.error, phaseId: options.phase_id });
    return { ok: false, error: validation.error };
  }
  const report = await writeStageReport(root, { phaseId: options.phase_id, attempt: options.attempt }, options.report_markdown);
  const result = await applyStoredEvent(root, {
    type: options.type, eventId: options.event_id ?? randomUUID(), runId: options.run_id,
    phaseId: options.phase_id, attempt: options.attempt, role: options.role,
    inReplyTo: options.in_reply_to, callbackTokenHash: validation.callbackTokenHash,
    payload: { ...(options.payload ?? {}), report },
  });
  let dispatch = [];
  if (result.accepted && result.effects?.some((effect) => effect.type === "DISPATCH_PHASE") && options.request) {
    dispatch = await dispatchReadyPhases(root, options.request, { workspaceId: options.workspaceId, timeoutMs: options.timeoutMs });
  }
  return { ok: result.accepted, state: readStoredWorkflow(root), effects: result.effects, dispatch, error: result.error?.code };
}

function contextAgent(context) {
  return context.agent_name ?? context.agentName ?? (typeof context.agent === "string" ? context.agent : context.agent?.name) ?? context.focused_pane?.agent ?? null;
}

function callbackProjectRoot(start) {
  let current = resolve(start);
  while (true) {
    try { readFileSync(join(current, ".herdr", "workflow", "state.json")); return current; } catch {}
    const parent = resolve(current, "..");
    if (parent === current) throw new Error("NATIVE_WORKFLOW_NOT_FOUND");
    current = parent;
  }
}

export function loadCallbackRequestFromContext(root, context = {}) {
  const state = readStoredWorkflow(root);
  const contract = JSON.parse(readFileSync(join(root, ".herdr", "workflow", "contract.json"), "utf8"));
  const agent = contextAgent(context);
  const candidates = Object.entries(state.phases).filter(([id, phase]) => ["DISPATCHED", "RUNNING"].includes(phase.status) && (!agent || contract.roles[contract.phases[id].role].agent === agent));
  if (candidates.length !== 1) throw new Error(agent ? `CALLBACK_PHASE_AMBIGUOUS agent=${agent}` : "CALLBACK_AGENT_CONTEXT_REQUIRED");
  const [phaseId, phase] = candidates[0];
  const callbacks = resolve(root, ".herdr", "workflow", "callbacks");
  const file = resolve(callbacks, `${phaseId}-attempt-${phase.attempt}.json`);
  if (!file.startsWith(`${callbacks}${sep}`)) throw new Error("CALLBACK_REQUEST_PATH_ESCAPE");
  const request = JSON.parse(readFileSync(file, "utf8"));
  return { file, request: { ...request, projectRoot: root } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  const request = (method, params) => requestSocket(process.env.HERDR_SOCKET_PATH, method, params);
  let root;
  let loaded;
  try { root = callbackProjectRoot(context.workspace_cwd ?? context.focused_pane_cwd ?? process.cwd()); loaded = loadCallbackRequestFromContext(root, context); }
  catch (error) { console.error(`HERDR_WORKFLOW_CALLBACK_ERROR ${error.message}`); process.exitCode = 1; }
  if (loaded) handleCallback({ ...loaded.request, workspaceId: context.workspace_id, request }).then((result) => {
    if (result.ok) try { unlinkSync(loaded.file); } catch {}
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => { console.error(`HERDR_WORKFLOW_CALLBACK_ERROR ${error.message}`); process.exitCode = 1; });
}
