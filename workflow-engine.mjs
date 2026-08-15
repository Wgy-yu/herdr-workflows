import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["COMPLETED", "REJECTED", "BLOCKED"]);

function clone(value) {
  return structuredClone(value);
}

function phaseState(status = "PENDING") {
  return {
    status,
    attempt: 1,
    dispatchedEventId: null,
    acceptedEventId: null,
    report: null,
    supersededAttempts: [],
    supersededReports: [],
  };
}

function activatablePendingPhaseIds(state, contract) {
  return Object.entries(contract.phases)
    .filter(([id, phase]) => state.phases[id]?.status === "PENDING" && phase.needs.every((need) => state.phases[need]?.status === "APPROVED"))
    .map(([id]) => id);
}

export function readyPhaseIds(state, contract) {
  return Object.keys(contract.phases).filter((id) => state.phases[id]?.status === "READY");
}

export function createWorkflowState(contract, entryMode = "do") {
  if (!['do', 'goal'].includes(entryMode)) throw new Error(`ENTRY_MODE_INVALID: ${entryMode}`);
  const phases = Object.fromEntries(Object.keys(contract.phases).map((id) => [id, phaseState()]));
  const state = {
    version: 1,
    workflowId: contract.workflowId,
    runId: randomUUID(),
    entryMode,
    status: "RUNNING",
    automaticHops: 0,
    reworkCount: 0,
    processedEventIds: [],
    lastEventId: null,
    lastError: null,
    phases,
  };
  for (const id of activatablePendingPhaseIds(state, contract)) state.phases[id].status = "READY";
  return state;
}

function reject(state, code, message = code) {
  return { state, effects: [], accepted: false, error: { code, message } };
}

function block(state, code, message = code) {
  state.status = "BLOCKED";
  state.lastError = { code, message };
  return {
    state,
    effects: [{ type: "BLOCK_WORKFLOW", code }, { type: "NOTIFY_LEADER", code }],
    accepted: true,
  };
}

function validateEvent(state, event, contract) {
  if (!event || typeof event !== "object" || !event.eventId) return "EVENT_INVALID";
  if (state.processedEventIds.includes(event.eventId)) return "EVENT_DUPLICATE";
  if (event.runId !== state.runId) return "RUN_ID_MISMATCH";
  if (TERMINAL.has(state.status)) return "WORKFLOW_TERMINAL";
  if (event.phaseId && !contract.phases[event.phaseId]) return "PHASE_UNKNOWN";
  const phase = event.phaseId ? state.phases[event.phaseId] : null;
  if (phase && event.attempt !== phase.attempt) return "ATTEMPT_MISMATCH";
  if (event.phaseId && event.role !== contract.phases[event.phaseId].role) return "ROLE_MISMATCH";
  const callbackTypes = ["PHASE_COMPLETED", "CHANGES_REQUESTED", "FINAL_DECISION", contract.phases[event.phaseId]?.callback?.type];
  if (phase?.callbackTokenHash && callbackTypes.includes(event.type) && event.callbackTokenHash !== phase.callbackTokenHash) {
    return "CALLBACK_TOKEN_MISMATCH";
  }
  return null;
}

function makeReady(state, contract, effects) {
  for (const id of activatablePendingPhaseIds(state, contract)) {
    state.phases[id].status = "READY";
    effects.push({ type: "DISPATCH_PHASE", phaseId: id, attempt: state.phases[id].attempt });
  }
}

export function reduceWorkflow(current, event, contract) {
  const invalid = validateEvent(current, event, contract);
  if (invalid) return reject(current, invalid);
  if (["AGENT_IDLE", "AGENT_DONE", "AGENT_UNKNOWN", "LIFECYCLE_OBSERVED"].includes(event.type)) {
    return { state: current, effects: [], accepted: false };
  }

  const state = clone(current);
  const effects = [];
  const phase = event.phaseId ? state.phases[event.phaseId] : null;
  const definition = event.phaseId ? contract.phases[event.phaseId] : null;

  if (event.type === "TURN_DISPATCHED") {
    if (phase.status !== "READY") return reject(current, "PHASE_NOT_READY");
    phase.status = "DISPATCHED";
    phase.dispatchedEventId = event.eventId;
    phase.callbackTokenHash = event.callbackTokenHash ?? null;
  } else if (event.type === "TURN_STARTED") {
    if (phase.status !== "DISPATCHED" || event.inReplyTo !== phase.dispatchedEventId) return reject(current, "CAUSATION_INVALID");
    phase.status = "RUNNING";
  } else if (event.type === "PHASE_BLOCKED" || event.type === "BLOCKED") {
    if (!["DISPATCHED", "RUNNING"].includes(phase.status)) return reject(current, "PHASE_STATE_INVALID");
    phase.status = "BLOCKED";
    state.processedEventIds.push(event.eventId);
    state.lastEventId = event.eventId;
    return block(state, "PHASE_BLOCKED", event.payload?.reason);
  } else if (event.type === "PHASE_COMPLETED" || (event.type === definition.callback.type && definition.kind !== "decision")) {
    if (!["RUNNING", "DISPATCHED"].includes(phase.status) || event.inReplyTo !== phase.dispatchedEventId) return reject(current, "CAUSATION_INVALID");
    phase.status = "APPROVED";
    phase.acceptedEventId = event.eventId;
    phase.report = event.payload?.report ?? null;
    if (definition.kind === "rework" && event.payload?.required === true) {
      if (state.reworkCount >= contract.maxRework) {
        state.processedEventIds.push(event.eventId);
        state.lastEventId = event.eventId;
        return block(state, "REWORK_LIMIT");
      }
      if (state.automaticHops >= contract.maxAutoHops) {
        state.processedEventIds.push(event.eventId);
        state.lastEventId = event.eventId;
        return block(state, "AUTO_HOP_LIMIT");
      }
      state.reworkCount += 1;
      state.automaticHops += 1;
      for (const [id, candidate] of Object.entries(contract.phases)) {
        if (candidate.kind !== "implementation") continue;
        const previous = state.phases[id];
        const retry = phaseState("READY");
        retry.attempt = previous.attempt + 1;
        retry.supersededAttempts = [...previous.supersededAttempts, previous.attempt];
        retry.supersededReports = [...previous.supersededReports, { attempt: previous.attempt, report: previous.report }];
        state.phases[id] = retry;
        effects.push({ type: "DISPATCH_PHASE", phaseId: id, attempt: retry.attempt });
      }
    } else {
      const activatable = activatablePendingPhaseIds(state, contract);
      if (activatable.length > 0 && state.automaticHops >= contract.maxAutoHops) {
        state.processedEventIds.push(event.eventId);
        state.lastEventId = event.eventId;
        return block(state, "AUTO_HOP_LIMIT");
      }
      if (activatable.length > 0) state.automaticHops += 1;
      makeReady(state, contract, effects);
      if (activatable.length === 0 && Object.entries(contract.phases).some(([id, candidate]) => {
        const phaseState = state.phases[id];
        return phaseState.status === "PENDING" && candidate.needs.some((need) => state.phases[need].status === "APPROVED");
      })) {
        state.status = "WAITING_FOR_JOIN";
      }
    }
  } else if (event.type === "FINAL_DECISION" || (definition.kind === "decision" && event.type === definition.callback.type)) {
    if (event.phaseId !== contract.finalPhaseId || !["RUNNING", "DISPATCHED"].includes(phase.status) || event.inReplyTo !== phase.dispatchedEventId) return reject(current, "FINAL_DECISION_INVALID");
    if (!["pass", "approved", "reject"].includes(event.payload?.decision)) return reject(current, "FINAL_DECISION_INVALID");
    phase.status = "APPROVED";
    phase.acceptedEventId = event.eventId;
    const passed = event.payload?.decision === "pass" || event.payload?.decision === "approved";
    state.status = passed ? "COMPLETED" : "REJECTED";
    effects.push({ type: "FINALIZE_WORKFLOW", decision: passed ? "pass" : "reject" });
  } else {
    return reject(current, "EVENT_TYPE_UNKNOWN");
  }

  state.processedEventIds.push(event.eventId);
  state.lastEventId = event.eventId;
  return { state, effects, accepted: true };
}
