import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgentTarget, handleNativeLifecycleEvent, normalizeSocketPath, parseEvent } from "../herdr-event-bridge.mjs";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow } from "../workflow-store.mjs";
import { createDispatchEnvelope } from "../workflow-protocol.mjs";

test("normalizes Herdr event and Windows socket path", () => { assert.equal(parseEvent(JSON.stringify({ type: "pane_agent_status_changed", agent_status: "idle" })).eventName, "pane.agent_status_changed"); assert.equal(normalizeSocketPath("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock"); });
test("finds Agent only inside requested workspace", () => { assert.equal(findAgentTarget([{ name: "worker", pane_id: "p1", workspace_id: "w1" }], "worker", "w1"), "p1"); assert.equal(findAgentTarget([{ name: "worker", pane_id: "p1", workspace_id: "w2" }], "worker", "w1"), null); });
test("idle and done require callback and never complete a phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-event-"));
  try { const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"), { agents: { leader: "leader" } }); let state = await startStoredWorkflow(root, contract); const envelope = createDispatchEnvelope(state, "design", contract); await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: envelope.eventId, runId: state.runId, phaseId: "design", attempt: 1, role: "leader", callbackTokenHash: envelope.callbackTokenHash }); const result = await handleNativeLifecycleEvent({ projectRoot: root, event: { agent: "leader", status: "done", eventId: "done" } }); assert.equal(result.callbackRequired, true); assert.equal(readStoredWorkflow(root).phases.design.status, "DISPATCHED"); } finally { rmSync(root, { recursive: true, force: true }); }
});
