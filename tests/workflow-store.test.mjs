import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { applyStoredEvent, repairWorkflow, replayWorkflow, startStoredWorkflow, writeStageReport } from "../workflow-store.mjs";

const contract = () => compileWorkflowDefinition(loadBuiltInTemplate("development"));

test("new engine ignores legacy state and enforces one active workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-store-"));
  try {
    writeFileSync(join(root, ".herdr", "workflow-state.json"), "{}", { flag: "w" });
  } catch { /* parent deliberately absent */ }
  try {
    const state = await startStoredWorkflow(root, contract(), "do");
    assert.equal(state.status, "RUNNING");
    assert.equal(existsSync(join(root, ".herdr", "workflow", "state.json")), true);
    await assert.rejects(startStoredWorkflow(root, contract(), "goal"), /WORKFLOW_ALREADY_ACTIVE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay detects and repair replaces a corrupted projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-store-"));
  try {
    await startStoredWorkflow(root, contract());
    writeFileSync(join(root, ".herdr", "workflow", "state.json"), "{}\n");
    assert.throws(() => replayWorkflow(root), /STATE_PROJECTION_MISMATCH/);
    assert.equal(repairWorkflow(root).status, "RUNNING");
    assert.equal(replayWorkflow(root).status, "RUNNING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports are bounded and immutable", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-store-"));
  try {
    await startStoredWorkflow(root, contract());
    const envelope = { phaseId: "design", attempt: 1 };
    await writeStageReport(root, envelope, "ok");
    assert.match(await writeStageReport(root, envelope, "ok"), /design-attempt-1\.md$/);
    await assert.rejects(writeStageReport(root, envelope, "again"), /REPORT_IMMUTABLE/);
    await assert.rejects(writeStageReport(root, { phaseId: "../escape", attempt: 1 }, "x"), /REPORT_PATH_ESCAPE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent duplicate events append and advance exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-store-"));
  try {
    const state = await startStoredWorkflow(root, contract());
    const event = { type: "TURN_DISPATCHED", eventId: "same", runId: state.runId, phaseId: "design", attempt: 1, role: "leader" };
    const results = await Promise.all([applyStoredEvent(root, event), applyStoredEvent(root, event)]);
    assert.equal(results.filter((item) => item.accepted).length, 1);
    assert.equal(replayWorkflow(root).sequence, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("crash injection preserves ordered recovery semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-store-crash-"));
  try {
    const state = await startStoredWorkflow(root, contract());
    const event = { type: "TURN_DISPATCHED", eventId: "crash-event", runId: state.runId, phaseId: "design", attempt: 1, role: "leader" };
    await assert.rejects(applyStoredEvent(root, event, { failAt: "before-append" }), /INJECTED_BEFORE_APPEND/);
    assert.equal(replayWorkflow(root).sequence, 1);
    await assert.rejects(applyStoredEvent(root, event, { failAt: "after-append" }), /INJECTED_AFTER_APPEND/);
    assert.throws(() => replayWorkflow(root), /STATE_PROJECTION_MISMATCH/);
    assert.equal(repairWorkflow(root).sequence, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
