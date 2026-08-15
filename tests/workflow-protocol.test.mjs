import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { createWorkflowState, reduceWorkflow } from "../workflow-engine.mjs";
import { createDispatchEnvelope, formatDispatchMessage, validateCallbackEnvelope } from "../workflow-protocol.mjs";

test("dispatch creates a one-time token and callback validates every correlation field", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"));
  let state = createWorkflowState(contract);
  const dispatch = createDispatchEnvelope(state, "design", contract);
  state = reduceWorkflow(state, { type: "TURN_DISPATCHED", eventId: dispatch.eventId, runId: state.runId, phaseId: "design", attempt: 1, role: "leader", callbackTokenHash: dispatch.callbackTokenHash }, contract).state;
  const callback = { workflow_id: state.workflowId, run_id: state.runId, phase_id: "design", attempt: 1, role: "leader", in_reply_to: dispatch.eventId, callback_token: dispatch.callbackToken, type: contract.phases.design.callback.type };
  assert.equal(validateCallbackEnvelope(callback, state, contract).valid, true);
  assert.equal(validateCallbackEnvelope({ ...callback, callback_token: "wrong" }, state, contract).error, "CALLBACK_TOKEN_INVALID");
  assert.equal(validateCallbackEnvelope({ ...callback, in_reply_to: "old" }, state, contract).error, "CALLBACK_CAUSATION_INVALID");
});

test("dispatch message is short and points to the contract", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"));
  const text = formatDispatchMessage(createDispatchEnvelope(createWorkflowState(contract), "design", contract));
  assert.match(text, /workflow_id=/);
  assert.match(text, /contract_path=/);
  assert.ok(Buffer.byteLength(text) < 1500);
  assert.doesNotMatch(text, /requiredTests/);
});
