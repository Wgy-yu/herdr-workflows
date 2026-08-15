import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow } from "../workflow-store.mjs";
import { createDispatchEnvelope } from "../workflow-protocol.mjs";
import { handleCallback, loadCallbackRequestFromContext } from "../herdr-workflow-callback.mjs";

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

test("parameterless Herdr Action derives the callback request from Agent context", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-callback-action-"));
  try {
    const contract = compileWorkflowDefinition(loadBuiltInTemplate("review-only"), { agents: { reviewer: "claude-reviewer", leader: "codex-leader" } });
    const state = await startStoredWorkflow(root, contract);
    const dispatch = createDispatchEnvelope(state, "review", contract);
    await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: dispatch.eventId, runId: state.runId, phaseId: "review", attempt: 1, role: "reviewer", callbackTokenHash: dispatch.callbackTokenHash });
    const dir = join(root, ".herdr", "workflow", "callbacks"); mkdirSync(dir, { recursive: true });
    const body = { workflow_id: state.workflowId, run_id: state.runId, phase_id: "review", event_id: "review-complete", attempt: 1, role: "reviewer", in_reply_to: dispatch.eventId, callback_token: dispatch.callbackToken, type: "review_complete", report_markdown: "REVIEW_PASS", payload: { verdict: "pass", findings: [] } };
    writeFileSync(join(dir, "review-attempt-1.json"), JSON.stringify(body));
    const loaded = loadCallbackRequestFromContext(root, { agent: { name: "claude-reviewer" } });
    assert.deepEqual(loaded.request.payload, body.payload);
    assert.equal(loaded.request.projectRoot, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
