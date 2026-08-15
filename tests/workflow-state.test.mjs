import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { readWorkflowState, startWorkflow } from "../workflow-state.mjs";

test("compatibility exports use only the native workflow directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-state-"));
  try { const contract = compileWorkflowDefinition(loadBuiltInTemplate("review-only")); await startWorkflow(root, contract, "do"); assert.equal(readWorkflowState(root).entryMode, "do"); } finally { rmSync(root, { recursive: true, force: true }); }
});
