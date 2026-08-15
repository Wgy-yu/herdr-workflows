import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeWorkflow } from "../herdr-workflow-dispatch.mjs";
import { handleCallback } from "../herdr-workflow-callback.mjs";
import { readStoredWorkflow, replayWorkflow } from "../workflow-store.mjs";

function fields(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes("=")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
}

test("frontend/backend fans out, joins, callbacks, finalizes and replays after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-e2e-"));
  const prompts = new Map();
  const agents = { leader: "leader", frontend: "frontend", backend: "backend", reviewer: "reviewer" };
  const request = async (method, params) => {
    if (method === "agent.list") return { result: { agents: Object.values(agents).map((name, index) => ({ name, pane_id: `w1:p${index + 1}`, workspace_id: "w1" })) } };
    if (method === "agent.get") return { result: { status: "idle" } };
    if (method === "agent.prompt") { const data = fields(params.text); prompts.set(data.phase_id, data); return { result: { status: "working" } }; }
    throw new Error(`unexpected ${method}`);
  };
  const submit = async (phaseId, payload = {}) => {
    const data = prompts.get(phaseId);
    assert.ok(data, `missing dispatch for ${phaseId}`);
    return handleCallback({ projectRoot: root, workspaceId: "w1", request, workflow_id: data.workflow_id, run_id: data.run_id, phase_id: phaseId, event_id: `complete-${phaseId}`, attempt: Number(data.attempt), role: data.role, in_reply_to: data.in_reply_to, callback_token: data.callback_token, type: data.callback_type, report_markdown: `# ${phaseId}\nverified`, payload });
  };
  try {
    await startNativeWorkflow({ projectRoot: root, template: "frontend-backend", agents, mode: "do", request, workspaceId: "w1" });
    await submit("design", { plan_path: ".herdr/design.md", accepted: true });
    assert.ok(prompts.has("frontend_implement"));
    assert.ok(prompts.has("backend_implement"));
    await submit("frontend_implement", { changed_files: ["src/frontend/a"], test_results: ["pass"] });
    assert.equal(readStoredWorkflow(root).phases.integration_review.status, "PENDING");
    await submit("backend_implement", { changed_files: ["src/backend/a"], test_results: ["pass"] });
    assert.ok(prompts.has("integration_review"));
    await submit("integration_review", { verdict: "pass", findings: [] });
    await submit("rework", { required: false, instructions: "" });
    await submit("verify", { verdict: "pass", evidence: ["tests"] });
    await submit("decision", { decision: "pass", rationale: "all gates passed" });
    assert.equal(readStoredWorkflow(root).status, "COMPLETED");
    assert.equal(replayWorkflow(root).status, "COMPLETED");
    assert.match(readFileSync(join(root, ".herdr", "workflow", "events.jsonl"), "utf8"), /complete-decision/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("do and goal are mutually exclusive in one repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-e2e-exclusive-"));
  const request = async (method) => method === "agent.list" ? { result: { agents: [] } } : { result: { status: "idle" } };
  try {
    await startNativeWorkflow({ projectRoot: root, template: "review-only", agents: {}, mode: "do", request, workspaceId: "w1" });
    await assert.rejects(startNativeWorkflow({ projectRoot: root, template: "review-only", agents: {}, mode: "goal", request, workspaceId: "w1" }), /WORKFLOW_ALREADY_ACTIVE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
