import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchWorkflow } from "../herdr-workflow-dispatch.mjs";
import { readWorkflowState } from "../workflow-state.mjs";

test("dispatch 读取共享计划、无等待通知实施者并立即进入实施阶段", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-dispatch-"));
  const calls = [];
  try {
    mkdirSync(join(root, ".herdr"), { recursive: true });
    writeFileSync(join(root, ".herdr", "workflow-plan.md"), "# 实施计划\n\n完成真实事件桥。", "utf8");
    const result = await dispatchWorkflow({
      projectRoot: root,
      workflow: { name: "default", implementer: "opencode" },
      workspaceId: "w1",
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "agent.list") {
          return { result: { agents: [{ name: "opencode", pane_id: "w1:p2", workspace_id: "w1" }] } };
        }
        return { result: { ok: true } };
      },
    });

    assert.equal(result.status, "IMPLEMENTATION_RUNNING");
    assert.deepEqual(calls.map((call) => call.method), ["agent.list", "agent.prompt"]);
    assert.equal("wait" in calls[1].params, false);
    assert.match(calls[1].params.text, /完成真实事件桥/);
    assert.equal(readWorkflowState(root).status, "IMPLEMENTATION_RUNNING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch 下发失败进入 BLOCKED 并允许 Leader 修复后重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflow-dispatch-failure-"));
  try {
    mkdirSync(join(root, ".herdr"), { recursive: true });
    writeFileSync(join(root, ".herdr", "workflow-plan.md"), "# 实施计划", "utf8");
    await assert.rejects(
      dispatchWorkflow({
        projectRoot: root,
        workflow: { name: "default", implementer: "opencode" },
        workspaceId: "w1",
        request: async (method) => {
          if (method === "agent.list") {
            return { result: { agents: [{ name: "opencode", pane_id: "w1:p2", workspace_id: "w1" }] } };
          }
          throw new Error("socket closed");
        },
      }),
      /下发失败/
    );
    assert.equal(readWorkflowState(root).status, "BLOCKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
