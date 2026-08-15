import { randomUUID } from "node:crypto";
import { appendStoredAuditEvent, applyStoredEvent, readStoredWorkflow, writeStageReport } from "./workflow-store.mjs";
import { validateCallbackEnvelope } from "./workflow-protocol.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  return { ok: result.accepted, state: result.state, effects: result.effects, error: result.error?.code };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  const input = JSON.parse(process.env.HERDR_PLUGIN_ACTION_JSON ?? "{}");
  handleCallback({ ...input, workspace_cwd: context.workspace_cwd ?? context.focused_pane_cwd }).then((result) => {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => { console.error(`HERDR_WORKFLOW_CALLBACK_ERROR ${error.message}`); process.exitCode = 1; });
}
