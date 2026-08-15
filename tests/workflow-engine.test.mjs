import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { createWorkflowState, reduceWorkflow } from "../workflow-engine.mjs";

const contract = () => compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"));
const event = (state, phaseId, type, extra = {}) => ({ type, eventId: crypto.randomUUID(), runId: state.runId, phaseId, attempt: state.phases[phaseId].attempt, role: contract().phases[phaseId].role, ...extra });

function complete(state, phaseId, definition) {
  let result = reduceWorkflow(state, event(state, phaseId, "TURN_DISPATCHED"), definition);
  const dispatched = result.state.phases[phaseId].dispatchedEventId;
  result = reduceWorkflow(result.state, event(result.state, phaseId, "TURN_STARTED", { inReplyTo: dispatched }), definition);
  return reduceWorkflow(result.state, event(result.state, phaseId, "PHASE_COMPLETED", { inReplyTo: dispatched }), definition).state;
}

test("parallel branches join only after both structured completions", () => {
  const definition = contract();
  let state = createWorkflowState(definition, "do");
  state = complete(state, "design", definition);
  state = complete(state, "frontend_implement", definition);
  assert.equal(state.phases.integration_review.status, "PENDING");
  let result = reduceWorkflow(state, event(state, "backend_implement", "TURN_DISPATCHED"), definition);
  const dispatch = result.state.phases.backend_implement.dispatchedEventId;
  result = reduceWorkflow(result.state, event(result.state, "backend_implement", "PHASE_COMPLETED", { inReplyTo: dispatch }), definition);
  assert.equal(result.state.phases.integration_review.status, "READY");
  assert.deepEqual(result.effects.map(({ type }) => type), ["DISPATCH_PHASE"]);
});

test("duplicate, stale run and lifecycle-only events do not advance state", () => {
  const definition = contract();
  const state = createWorkflowState(definition);
  const dispatched = event(state, "design", "TURN_DISPATCHED");
  const next = reduceWorkflow(state, dispatched, definition).state;
  assert.equal(reduceWorkflow(next, dispatched, definition).error.code, "EVENT_DUPLICATE");
  assert.equal(reduceWorkflow(next, { ...event(next, "design", "TURN_STARTED"), runId: "old" }, definition).error.code, "RUN_ID_MISMATCH");
  assert.equal(reduceWorkflow(next, event(next, "design", "AGENT_UNKNOWN"), definition).accepted, false);
});

test("the ninth automatic hop blocks the workflow", () => {
  const definition = contract();
  let state = createWorkflowState(definition);
  state.automaticHops = 8;
  let result = reduceWorkflow(state, event(state, "design", "TURN_DISPATCHED"), definition);
  const dispatch = result.state.phases.design.dispatchedEventId;
  result = reduceWorkflow(result.state, event(result.state, "design", "PHASE_COMPLETED", { inReplyTo: dispatch }), definition);
  assert.equal(result.state.status, "BLOCKED");
  assert.equal(result.state.lastError.code, "AUTO_HOP_LIMIT");
});
