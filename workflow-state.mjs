import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKFLOW_STATE_FILE = join(".herdr", "workflow-state.json");

const TRANSITIONS = {
  IMPLEMENTATION_RUNNING: {
    implementation_done: "REVIEW_RUNNING",
    implementation_blocked: "BLOCKED",
  },
  REVIEW_RUNNING: {
    review_done: "FINAL_DECISION_PENDING",
    review_blocked: "BLOCKED",
  },
};

function stateFile(projectRoot) {
  return join(projectRoot, WORKFLOW_STATE_FILE);
}

function saveWorkflowState(projectRoot, state) {
  const file = stateFile(projectRoot);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
  return state;
}

export function readWorkflowState(projectRoot) {
  const file = stateFile(projectRoot);
  if (!existsSync(file)) {
    return { version: 1, workflow: null, status: "READY", sequence: 0, eventKeys: [] };
  }
  const state = JSON.parse(readFileSync(file, "utf8"));
  return { ...state, eventKeys: Array.isArray(state.eventKeys) ? state.eventKeys : [] };
}

export function startWorkflow(projectRoot, workflow) {
  const current = readWorkflowState(projectRoot);
  if (!["READY", "FINAL_DECISION_PENDING", "BLOCKED"].includes(current.status)) {
    throw new Error(`当前状态不允许 dispatch：${current.status}`);
  }
  return saveWorkflowState(projectRoot, {
    version: 1,
    workflow,
    status: "IMPLEMENTATION_RUNNING",
    sequence: current.sequence + 1,
    eventKeys: [],
    updatedAt: new Date().toISOString(),
  });
}

export function transitionWorkflow(projectRoot, reason, eventKey) {
  const current = readWorkflowState(projectRoot);
  if (eventKey && current.eventKeys.includes(eventKey)) {
    throw new Error(`重复工作流事件：${eventKey}`);
  }
  const nextStatus = TRANSITIONS[current.status]?.[reason];
  if (!nextStatus) {
    throw new Error(`非法工作流迁移：${current.status} + ${reason}`);
  }
  return saveWorkflowState(projectRoot, {
    ...current,
    status: nextStatus,
    sequence: current.sequence + 1,
    eventKeys: eventKey ? [...current.eventKeys, eventKey] : current.eventKeys,
    lastReason: reason,
    updatedAt: new Date().toISOString(),
  });
}

export function blockWorkflow(projectRoot, reason) {
  const current = readWorkflowState(projectRoot);
  return saveWorkflowState(projectRoot, {
    ...current,
    status: "BLOCKED",
    sequence: current.sequence + 1,
    lastReason: reason,
    updatedAt: new Date().toISOString(),
  });
}
