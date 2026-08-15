import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProject, selectTemplateAgents } from "../herdr-workflow-init.mjs";

const agents = [
  { name: "codex-leader", kind: "codex", pane_id: "p1", workspace_id: "w1" },
  { name: "opencode-frontend", kind: "opencode", pane_id: "p2", workspace_id: "w1" },
  { name: "opencode-backend", kind: "opencode", pane_id: "p3", workspace_id: "w1" },
  { name: "claude-reviewer", kind: "claude", pane_id: "p4", workspace_id: "w1" },
];

test("frontend/backend init maps distinct workspace agents and writes validated config", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-init-"));
  try {
    const result = await initializeProject({ projectRoot: root, actionId: "init-frontend-backend", context: { workspace_id: "w1", focused_pane_id: "p1" }, request: async () => ({ result: { agents } }) });
    assert.equal(result.status, "INIT_READY");
    assert.deepEqual(result.roles, { leader: "codex-leader", frontend: "opencode-frontend", backend: "opencode-backend", reviewer: "claude-reviewer" });
    const yaml = readFileSync(join(root, ".herdr", "workflows.yaml"), "utf8");
    assert.match(yaml, /template: frontend-backend/);
    assert.match(yaml, /structured_callbacks_required: true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init reports missing roles without writing partial config", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-init-missing-"));
  try {
    const result = await initializeProject({ projectRoot: root, actionId: "init-development", context: { workspace_id: "w1" }, request: async () => ({ result: { agents: agents.slice(0, 2) } }) });
    assert.equal(result.status, "INIT_INPUT_REQUIRED");
    assert.deepEqual(result.missing_roles, ["implementer"]);
    assert.throws(() => readFileSync(join(root, ".herdr", "workflows.yaml")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("focused Agent is selected as Leader", () => {
  assert.equal(selectTemplateAgents("review-only", agents, { focused_pane_id: "p3" }).leader, "opencode-backend");
});

test("plugin manifest exposes every template init through Herdr CLI Actions", () => {
  const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  for (const id of ["init", "init-development", "init-frontend-backend", "init-review-only"]) {
    assert.match(manifest, new RegExp(`id = "${id}"`));
  }
  assert.match(manifest, /command = \["node", "herdr-workflow-init\.mjs"\]/);
});
