import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readWorkflowState,
  startWorkflow,
  transitionWorkflow,
} from "../workflow-state.mjs";

test("新工作流从 READY 一次性进入实施阶段", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-state-"));
  try {
    assert.equal(readWorkflowState(root).status, "READY");
    assert.equal(startWorkflow(root, "default").status, "IMPLEMENTATION_RUNNING");
    assert.throws(() => startWorkflow(root, "default"), /当前状态不允许 dispatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("状态机只接受当前阶段对应的官方事件", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-state-"));
  try {
    startWorkflow(root, "default");
    assert.throws(
      () => transitionWorkflow(root, "review_done", "event-review-early"),
      /非法工作流迁移/
    );
    assert.equal(
      transitionWorkflow(root, "implementation_done", "event-implementation").status,
      "REVIEW_RUNNING"
    );
    assert.equal(
      transitionWorkflow(root, "review_done", "event-review").status,
      "FINAL_DECISION_PENDING"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一个事件键不能重复推进", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-state-"));
  try {
    startWorkflow(root, "default");
    transitionWorkflow(root, "implementation_done", "same-event");
    assert.throws(() => transitionWorkflow(root, "review_done", "same-event"), /重复工作流事件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
