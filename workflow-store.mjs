import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkflowState, reduceWorkflow } from "./workflow-engine.mjs";

const ROOT = join(".herdr", "workflow");
const LOCK_TTL = 30_000;
const pathOf = (root, ...parts) => join(root, ROOT, ...parts);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function lockExpired(file, snapshot) {
  try {
    const metadata = JSON.parse(snapshot);
    try { process.kill(metadata.pid, 0); } catch (error) { if (error.code === "ESRCH") return true; }
    return Date.now() - statSync(file).mtimeMs > LOCK_TTL && readFileSync(file, "utf8") === snapshot;
  } catch { return Date.now() - statSync(file).mtimeMs > LOCK_TTL; }
}

export async function withWorkflowLock(root, operation, name = "mutation") {
  mkdirSync(pathOf(root), { recursive: true });
  const file = pathOf(root, "lock.json");
  const deadline = Date.now() + 8_000;
  let descriptor;
  let token;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(file, "wx");
      token = randomUUID();
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, operation: name, acquiredAt: new Date().toISOString() }), "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let snapshot;
      try { snapshot = readFileSync(file, "utf8"); } catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
      if (lockExpired(file, snapshot)) { try { unlinkSync(file); } catch {} continue; }
      if (Date.now() >= deadline) throw new Error("WORKFLOW_LOCK_TIMEOUT");
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  try { return await operation(); } finally {
    closeSync(descriptor);
    try { if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file); } catch {}
  }
}

function assertStorePath(root) {
  const base = resolve(root);
  const target = resolve(pathOf(root));
  if (!target.startsWith(`${base}${sep}`)) throw new Error("WORKFLOW_PATH_ESCAPE");
  return target;
}

function writeProjections(root, state) {
  for (const [id, phase] of Object.entries(state.phases)) atomic(pathOf(root, "phases", `${id}.json`), phase);
  atomic(pathOf(root, "state.json"), state);
}

export async function startStoredWorkflow(root, contract, mode = "do") {
  return withWorkflowLock(root, async () => {
    assertStorePath(root);
    const stateFile = pathOf(root, "state.json");
    if (existsSync(stateFile) && !["COMPLETED", "REJECTED"].includes(json(stateFile).status)) throw new Error("WORKFLOW_ALREADY_ACTIVE");
    const state = createWorkflowState(contract, mode);
    mkdirSync(pathOf(root), { recursive: true });
    atomic(pathOf(root, "contract.json"), contract);
    atomic(pathOf(root, "definition.yaml"), `# compiled workflow: ${contract.template}\n`);
    state.sequence = 1;
    const created = { sequence: 1, type: "WORKFLOW_CREATED", eventId: randomUUID(), state };
    atomic(pathOf(root, "events.jsonl"), `${JSON.stringify(created)}\n`);
    writeProjections(root, state);
    return state;
  }, "start");
}

export function readStoredWorkflow(root) {
  return json(pathOf(root, "state.json"));
}

export async function applyStoredEvent(root, event, options = {}) {
  return withWorkflowLock(root, async () => {
    const contract = json(pathOf(root, "contract.json"));
    const current = readStoredWorkflow(root);
    const result = reduceWorkflow(current, event, contract);
    if (!result.accepted) return result;
    const sequence = current.sequence + 1;
    if (options.failAt === "before-append") throw new Error("INJECTED_BEFORE_APPEND");
    result.state.sequence = sequence;
    appendFileSync(pathOf(root, "events.jsonl"), `${JSON.stringify({ sequence, event })}\n`, "utf8");
    if (options.failAt === "after-append") throw new Error("INJECTED_AFTER_APPEND");
    writeProjections(root, result.state);
    return result;
  }, "apply-event");
}

export async function appendStoredAuditEvent(root, event) {
  return withWorkflowLock(root, async () => {
    appendFileSync(pathOf(root, "events.jsonl"), `${JSON.stringify({ audit: true, at: new Date().toISOString(), event })}\n`, "utf8");
    return event;
  }, "audit-event");
}

export async function writeStageReport(root, envelope, markdown) {
  if (typeof markdown !== "string" || !markdown.trim() || Buffer.byteLength(markdown) > 256 * 1024) throw new Error("REPORT_INVALID");
  const name = `${envelope.phaseId}-attempt-${envelope.attempt}.md`;
  const file = resolve(pathOf(root, "reports", name));
  const reports = resolve(pathOf(root, "reports"));
  if (!file.startsWith(`${reports}${sep}`)) throw new Error("REPORT_PATH_ESCAPE");
  mkdirSync(reports, { recursive: true });
  const realStore = realpathSync(pathOf(root));
  const realReports = realpathSync(reports);
  if (realReports !== realStore && !realReports.startsWith(`${realStore}${sep}`)) throw new Error("REPORT_PATH_ESCAPE");
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") === markdown) return file;
    throw new Error("REPORT_IMMUTABLE");
  }
  atomic(file, markdown);
  return file;
}

function replayEvents(root) {
  const records = readFileSync(pathOf(root, "events.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (!records.length || records[0].type !== "WORKFLOW_CREATED") throw new Error("EVENT_LOG_INVALID");
  const contract = json(pathOf(root, "contract.json"));
  let replayed = structuredClone(records[0].state);
  for (const record of records.slice(1).filter((record) => !record.audit)) {
    if (!record.event || record.sequence !== replayed.sequence + 1) throw new Error("EVENT_LOG_INVALID");
    const result = reduceWorkflow(replayed, record.event, contract);
    if (!result.accepted) throw new Error(`EVENT_REPLAY_REJECTED:${result.error?.code ?? "UNKNOWN"}`);
    replayed = result.state;
    replayed.sequence = record.sequence;
  }
  return replayed;
}

export function replayWorkflow(root) {
  const replayed = replayEvents(root);
  if (JSON.stringify(replayed) !== JSON.stringify(readStoredWorkflow(root))) throw new Error("STATE_PROJECTION_MISMATCH");
  return replayed;
}

export function repairWorkflow(root) {
  const state = replayEvents(root);
  writeProjections(root, state);
  return state;
}
