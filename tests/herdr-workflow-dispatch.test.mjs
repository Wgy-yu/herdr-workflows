import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextStartPath, startNativeWorkflow } from "../herdr-workflow-dispatch.mjs";

test("native dispatch persists dispatch before bounded delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-dispatch-")); const calls = [];
  try {
    const result = await startNativeWorkflow({ projectRoot: root, template: "development", agents: { leader: "leader" }, workspaceId: "w1", request: async (method, params) => { calls.push({ method, params }); if (method === "agent.list") return { result: { agents: [{ name: "leader", pane_id: "p1", workspace_id: "w1" }] } }; if (method === "agent.get") return { result: { status: "idle" } }; return { result: { status: "working" } }; } });
    assert.equal(result.state.phases.design.status, "RUNNING");
    assert.deepEqual(calls.map(({ method }) => method), ["agent.list", "agent.get", "agent.prompt"]);
    assert.match(calls[2].params.text, /callback_token=/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Action context prefers workspace cwd", () => { assert.equal(contextStartPath({ workspace_cwd: "C:/repo", focused_pane_cwd: "C:/other" }), "C:/repo"); });
test("missing Agent persists an explicitly blocked branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-dispatch-blocked-"));
  try { const result = await startNativeWorkflow({ projectRoot: root, template: "review-only", agents: {}, workspaceId: "w1", request: async () => ({ result: { agents: [] } }) }); assert.equal(result.state.status, "BLOCKED"); assert.equal(result.state.phases.review.status, "BLOCKED"); } finally { rmSync(root, { recursive: true, force: true }); }
});
