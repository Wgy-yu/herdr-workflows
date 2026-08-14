import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKFLOW_STATE_FILE = join(".herdr", "workflow-state.json");
export const WORKFLOW_EVENTS_FILE = join(".herdr", "workflow-events.jsonl");

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

export function canTransitionWorkflow(status, reason) {
  return Boolean(TRANSITIONS[status]?.[reason]);
}

export function nextWorkflowStatus(status, reason) {
  return TRANSITIONS[status]?.[reason] ?? null;
}

function stateFile(projectRoot) {
  return join(projectRoot, WORKFLOW_STATE_FILE);
}

function lockFile(projectRoot) {
  return join(projectRoot, ".herdr", "workflow.lock");
}

function reclaimDeadOwnerLock(file) {
  let ownerPid;
  let ownerText;
  try {
    ownerText = readFileSync(file, "utf8").trim();
    ownerPid = Number.parseInt(ownerText, 10);
  } catch {
    return false;
  }
  let reclaim = false;
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      reclaim = error.code === "ESRCH";
    }
  }
  try { reclaim ||= Date.now() - statSync(file).mtimeMs > 30_000; } catch { return false; }
  if (!reclaim) return false;
  try {
    const current = readFileSync(file, "utf8").trim();
    if (current !== ownerText) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(projectRoot) {
  mkdirSync(join(projectRoot, ".herdr"), { recursive: true });
  const file = lockFile(projectRoot);
  const deadline = Date.now() + 8000;
  while (true) {
    try {
      const descriptor = openSync(file, "wx");
      try { writeFileSync(descriptor, `${process.pid}\n`, "utf8"); }
      catch (error) { closeSync(descriptor); try { unlinkSync(file); } catch {} throw error; }
      return () => {
        closeSync(descriptor);
        try { unlinkSync(file); } catch {}
      };
    } catch (error) {
      if (error.code === "EEXIST" && reclaimDeadOwnerLock(file)) continue;
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export async function withWorkflowLock(projectRoot, operation) {
  mkdirSync(join(projectRoot, ".herdr"), { recursive: true });
  const file = lockFile(projectRoot);
  const deadline = Date.now() + 8000;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(file, "wx");
      try { writeFileSync(descriptor, `${process.pid}\n`, "utf8"); }
      catch (error) { closeSync(descriptor); descriptor = undefined; try { unlinkSync(file); } catch {} throw error; }
    } catch (error) {
      if (error.code === "EEXIST" && reclaimDeadOwnerLock(file)) continue;
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(file); } catch {}
  }
}

export function appendWorkflowEvent(projectRoot, record) {
  const file = join(projectRoot, WORKFLOW_EVENTS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
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

export function startWorkflowUnlocked(projectRoot, workflow) {
  const current = readWorkflowState(projectRoot);
  if (!["READY", "FINAL_DECISION_PENDING", "BLOCKED"].includes(current.status)) {
    throw new Error(`当前状态不允许 dispatch：${current.status}`);
  }
  return saveWorkflowState(projectRoot, {
    version: 1,
    runId: `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`,
    workflow,
    status: "IMPLEMENTATION_RUNNING",
    sequence: current.sequence + 1,
    eventKeys: [],
    updatedAt: new Date().toISOString(),
  });
}

export function startWorkflow(projectRoot, workflow) {
  const release = acquireLock(projectRoot);
  try { return startWorkflowUnlocked(projectRoot, workflow); } finally { release(); }
}

export function transitionWorkflowUnlocked(projectRoot, reason, eventKey) {
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

export function transitionWorkflow(projectRoot, reason, eventKey) {
  const release = acquireLock(projectRoot);
  try { return transitionWorkflowUnlocked(projectRoot, reason, eventKey); } finally { release(); }
}

export function blockWorkflow(projectRoot, reason) {
  const release = acquireLock(projectRoot);
  try {
  const current = readWorkflowState(projectRoot);
  return saveWorkflowState(projectRoot, {
    ...current,
    status: "BLOCKED",
    sequence: current.sequence + 1,
    lastReason: reason,
    updatedAt: new Date().toISOString(),
  });
  } finally { release(); }
}
