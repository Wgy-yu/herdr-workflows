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
  const callback = { workflow_id: state.workflowId, run_id: state.runId, phase_id: "design", attempt: 1, role: "leader", in_reply_to: dispatch.eventId, callback_token: dispatch.callbackToken, type: contract.phases.design.callback.type, payload: { plan_path: ".herdr/plan.md", accepted: true } };
  assert.equal(validateCallbackEnvelope(callback, state, contract).valid, true);
  assert.equal(validateCallbackEnvelope({ ...callback, callback_token: "wrong" }, state, contract).error, "CALLBACK_TOKEN_INVALID");
  assert.equal(validateCallbackEnvelope({ ...callback, in_reply_to: "old" }, state, contract).error, "CALLBACK_CAUSATION_INVALID");
});

test("implementation changes stay in writable scope and reviewers cannot report writes", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"));
  let state = createWorkflowState(contract); state.phases.frontend_implement.status = "READY";
  const dispatch = createDispatchEnvelope(state, "frontend_implement", contract);
  state = reduceWorkflow(state, { type: "TURN_DISPATCHED", eventId: dispatch.eventId, runId: state.runId, phaseId: "frontend_implement", attempt: 1, role: "frontend", callbackTokenHash: dispatch.callbackTokenHash }, contract).state;
  const base = { workflow_id: state.workflowId, run_id: state.runId, phase_id: "frontend_implement", attempt: 1, role: "frontend", in_reply_to: dispatch.eventId, callback_token: dispatch.callbackToken, type: contract.phases.frontend_implement.callback.type, payload: { changed_files: ["src/frontend/a.js"], test_results: ["pass"] } };
  assert.equal(validateCallbackEnvelope(base, state, contract).valid, true);
  assert.equal(validateCallbackEnvelope({ ...base, payload: { ...base.payload, changed_files: ["src/backend/a.js"] } }, state, contract).error, "WRITE_SCOPE_VIOLATION");
  state = createWorkflowState(contract); state.phases.integration_review.status = "READY";
  const reviewDispatch = createDispatchEnvelope(state, "integration_review", contract);
  state = reduceWorkflow(state, { type: "TURN_DISPATCHED", eventId: reviewDispatch.eventId, runId: state.runId, phaseId: "integration_review", attempt: 1, role: "reviewer", callbackTokenHash: reviewDispatch.callbackTokenHash }, contract).state;
  const review = { workflow_id: state.workflowId, run_id: state.runId, phase_id: "integration_review", attempt: 1, role: "reviewer", in_reply_to: reviewDispatch.eventId, callback_token: reviewDispatch.callbackToken, type: contract.phases.integration_review.callback.type, payload: { verdict: "pass", findings: [], changed_files: ["src/frontend/a.js"] } };
  assert.equal(validateCallbackEnvelope(review, state, contract).error, "REVIEWER_WRITE_FORBIDDEN");
});

test("dispatch message is short and points to the contract", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"));
  const text = formatDispatchMessage(createDispatchEnvelope(createWorkflowState(contract), "design", contract));
  assert.match(text, /workflow_id=/);
  assert.match(text, /contract_path=/);
  assert.ok(Buffer.byteLength(text) < 1500);
  assert.doesNotMatch(text, /requiredTests/);
});
