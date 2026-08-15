import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow } from "../workflow-store.mjs";
import { createDispatchEnvelope } from "../workflow-protocol.mjs";
import { handleCallback } from "../herdr-workflow-callback.mjs";

test("callback stores report and advances only after authenticated correlation", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-callback-"));
  try {
    const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"));
    let state = await startStoredWorkflow(root, contract);
    const dispatch = createDispatchEnvelope(state, "design", contract);
    await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: dispatch.eventId, runId: state.runId, phaseId: "design", attempt: 1, role: "leader", callbackTokenHash: dispatch.callbackTokenHash });
    state = readStoredWorkflow(root);
    const base = { projectRoot: root, workflow_id: state.workflowId, run_id: state.runId, phase_id: "design", event_id: "callback-1", attempt: 1, role: "leader", in_reply_to: dispatch.eventId, type: contract.phases.design.callback.type, report_markdown: "# report", payload: { plan_path: ".herdr/plan.md", accepted: true } };
    assert.equal((await handleCallback({ ...base, callback_token: "wrong" })).ok, false);
    assert.equal(readStoredWorkflow(root).phases.design.status, "DISPATCHED");
    assert.match(readFileSync(join(root, ".herdr", "workflow", "events.jsonl"), "utf8"), /CALLBACK_REJECTED/);
    assert.equal((await handleCallback({ ...base, event_id: "callback-2", callback_token: dispatch.callbackToken })).ok, true);
    assert.equal(readStoredWorkflow(root).phases.design.status, "APPROVED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
