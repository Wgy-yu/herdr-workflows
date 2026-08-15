import { randomUUID } from "node:crypto";
import { appendStoredAuditEvent, applyStoredEvent, readStoredWorkflow, writeStageReport } from "./workflow-store.mjs";
import { validateCallbackEnvelope } from "./workflow-protocol.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
