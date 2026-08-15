import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { createWorkflowState, readyPhaseIds, reduceWorkflow } from "../workflow-engine.mjs";

const contract = () => compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"));
const event = (state, phaseId, type, extra = {}) => ({ type, eventId: crypto.randomUUID(), runId: state.runId, phaseId, attempt: state.phases[phaseId].attempt, role: contract().phases[phaseId].role, ...extra });

test("readyPhaseIds exposes phases that are ready to dispatch", () => {
  const definition = contract();
  const state = createWorkflowState(definition, "do");
  assert.deepEqual(readyPhaseIds(state, definition), ["design"]);
});

function complete(state, phaseId, definition) {
  let result = reduceWorkflow(state, event(state, phaseId, "TURN_DISPATCHED"), definition);
  const dispatched = result.state.phases[phaseId].dispatchedEventId;
  result = reduceWorkflow(result.state, event(result.state, phaseId, "TURN_STARTED", { inReplyTo: dispatched }), definition);
  return reduceWorkflow(result.state, event(result.state, phaseId, "PHASE_COMPLETED", { inReplyTo: dispatched }), definition).state;
}

function completeWithPayload(state, phaseId, definition, payload) {
  let result = reduceWorkflow(state, event(state, phaseId, "TURN_DISPATCHED"), definition);
  const dispatched = result.state.phases[phaseId].dispatchedEventId;
  result = reduceWorkflow(result.state, event(result.state, phaseId, "TURN_STARTED", { inReplyTo: dispatched }), definition);
  return reduceWorkflow(result.state, event(result.state, phaseId, "PHASE_COMPLETED", { inReplyTo: dispatched, payload }), definition);
}

function stateAtRework(definition) {
  let state = createWorkflowState(definition, "do");
  for (const phaseId of ["design", "frontend_implement", "backend_implement", "integration_review"]) {
    state = complete(state, phaseId, definition);
  }
  return state;
}

function stateAtDecision(definition) {
  let state = stateAtRework(definition);
  state = complete(state, "rework", definition);
  return complete(state, "verify", definition);
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

test("a blocked branch blocks the workflow and terminal state is immutable", () => {
  const definition = contract();
  let state = createWorkflowState(definition, "do");
  const dispatched = event(state, "design", "TURN_DISPATCHED");
  state = reduceWorkflow(state, dispatched, definition).state;
  const blocked = reduceWorkflow(
    state,
    event(state, "design", "BLOCKED", { inReplyTo: dispatched.eventId, payload: { reason: "agent unavailable" } }),
    definition
  );
  assert.equal(blocked.accepted, true);
  assert.equal(blocked.state.phases.design.status, "BLOCKED");
  assert.equal(blocked.state.status, "BLOCKED");
  assert.deepEqual(blocked.effects.map((effect) => effect.type), ["BLOCK_WORKFLOW", "NOTIFY_LEADER"]);

  const terminalAttempt = reduceWorkflow(
    blocked.state,
    event(blocked.state, "design", "TURN_STARTED", { inReplyTo: dispatched.eventId }),
    definition
  );
  assert.equal(terminalAttempt.accepted, false);
  assert.equal(terminalAttempt.error.code, "WORKFLOW_TERMINAL");
  assert.equal(terminalAttempt.state, blocked.state);
});

test("rework creates a new implementation attempt and records the superseded attempt", () => {
  const definition = contract();
  const state = stateAtRework(definition);
  const result = completeWithPayload(state, "rework", definition, { required: true });
  assert.equal(result.accepted, true);
  assert.equal(result.state.reworkCount, 1);
  assert.equal(result.state.phases.frontend_implement.attempt, 2);
  assert.deepEqual(result.state.phases.frontend_implement.supersededAttempts, [1]);
  assert.deepEqual(result.effects.map((effect) => effect.phaseId), ["frontend_implement", "backend_implement"]);
});

test("a phase accepts its Contract-declared structured callback", () => {
  const definition = contract();
  let state = createWorkflowState(definition, "do");
  const dispatched = event(state, "design", "TURN_DISPATCHED");
  state = reduceWorkflow(state, dispatched, definition).state;
  const callback = reduceWorkflow(
    state,
    event(state, "design", definition.phases.design.callback.type, { inReplyTo: dispatched.eventId }),
    definition
  );
  assert.equal(callback.accepted, true);
  assert.equal(callback.state.phases.design.status, "APPROVED");
});

test("callbacks reject missing causation, stale attempts, wrong roles, and wrong tokens", () => {
  const definition = contract();
  let state = createWorkflowState(definition, "do");
  const dispatched = event(state, "design", "TURN_DISPATCHED");
  state = reduceWorkflow(state, dispatched, definition).state;
  state = {
    ...state,
    phases: { ...state.phases, design: { ...state.phases.design, callbackTokenHash: "expected-token-hash" } },
  };

  const missingCausation = reduceWorkflow(
    state,
    event(state, "design", "PHASE_COMPLETED", { callbackTokenHash: "expected-token-hash" }),
    definition
  );
  assert.equal(missingCausation.error.code, "CAUSATION_INVALID");
  const staleAttempt = reduceWorkflow(
    state,
    event(state, "design", "PHASE_COMPLETED", { attempt: 0, inReplyTo: dispatched.eventId, callbackTokenHash: "expected-token-hash" }),
    definition
  );
  assert.equal(staleAttempt.error.code, "ATTEMPT_MISMATCH");
  const wrongRole = reduceWorkflow(
    state,
    event(state, "design", "PHASE_COMPLETED", { role: "reviewer", inReplyTo: dispatched.eventId, callbackTokenHash: "expected-token-hash" }),
    definition
  );
  assert.equal(wrongRole.error.code, "ROLE_MISMATCH");
  const wrongToken = reduceWorkflow(
    state,
    event(state, "design", "PHASE_COMPLETED", { inReplyTo: dispatched.eventId, callbackTokenHash: "wrong" }),
    definition
  );
  assert.equal(wrongToken.error.code, "CALLBACK_TOKEN_MISMATCH");
  assert.equal(wrongToken.state, state);
});

test("rework at its configured limit blocks instead of creating another attempt", () => {
  const definition = contract();
  const state = { ...stateAtRework(definition), reworkCount: definition.maxRework };
  const result = completeWithPayload(state, "rework", definition, { required: true });
  assert.equal(result.accepted, true);
  assert.equal(result.state.status, "BLOCKED");
  assert.equal(result.state.lastError.code, "REWORK_LIMIT");
  assert.deepEqual(result.effects.map((effect) => effect.type), ["BLOCK_WORKFLOW", "NOTIFY_LEADER"]);
});

test("FINAL_DECISION completes or rejects the workflow and finalizes exactly once", () => {
  for (const [decision, expectedStatus] of [["pass", "COMPLETED"], ["reject", "REJECTED"]]) {
    const definition = contract();
    let state = stateAtDecision(definition);
    const dispatched = event(state, "decision", "TURN_DISPATCHED");
    state = reduceWorkflow(state, dispatched, definition).state;
    const result = reduceWorkflow(
      state,
      event(state, "decision", "FINAL_DECISION", { inReplyTo: dispatched.eventId, payload: { decision } }),
      definition
    );
    assert.equal(result.accepted, true);
    assert.equal(result.state.status, expectedStatus);
    assert.deepEqual(result.effects, [{ type: "FINALIZE_WORKFLOW", decision }]);
  }
});

test("a parallel completion that does not activate another phase does not consume an automatic hop", () => {
  const definition = contract();
  let state = complete(createWorkflowState(definition, "do"), "design", definition);
  state = { ...state, automaticHops: definition.maxAutoHops };
  const result = completeWithPayload(state, "frontend_implement", definition, {});
  assert.equal(result.accepted, true);
  assert.equal(result.state.status, "WAITING_FOR_JOIN");
  assert.equal(result.state.phases.integration_review.status, "PENDING");
  assert.equal(result.state.automaticHops, definition.maxAutoHops);
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
