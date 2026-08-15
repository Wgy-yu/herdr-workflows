import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { repairWorkflow, replayWorkflow, startStoredWorkflow, writeStageReport } from "../workflow-store.mjs";

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
    await assert.rejects(writeStageReport(root, envelope, "again"), /REPORT_IMMUTABLE/);
    await assert.rejects(writeStageReport(root, { phaseId: "../escape", attempt: 1 }, "x"), /REPORT_PATH_ESCAPE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
