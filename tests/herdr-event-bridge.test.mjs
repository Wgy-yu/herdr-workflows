import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgentTarget, handleNativeLifecycleEvent, normalizeSocketPath, parseEvent } from "../herdr-event-bridge.mjs";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";
import { applyStoredEvent, readStoredWorkflow, startStoredWorkflow } from "../workflow-store.mjs";
import { createDispatchEnvelope } from "../workflow-protocol.mjs";
import { startNativeWorkflow } from "../herdr-workflow-dispatch.mjs";
import { loadCallbackRequestFromContext } from "../herdr-workflow-callback.mjs";

test("normalizes Herdr event and Windows socket path", () => { assert.equal(parseEvent(JSON.stringify({ type: "pane_agent_status_changed", agent_status: "idle" })).eventName, "pane.agent_status_changed"); assert.equal(normalizeSocketPath("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock"); });
test("finds Agent only inside requested workspace", () => { assert.equal(findAgentTarget([{ name: "worker", pane_id: "p1", workspace_id: "w1" }], "worker", "w1"), "p1"); assert.equal(findAgentTarget([{ name: "worker", pane_id: "p1", workspace_id: "w2" }], "worker", "w1"), null); });
test("idle and done require callback and never complete a phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-event-"));
  try { const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"), { agents: { leader: "leader" } }); let state = await startStoredWorkflow(root, contract); const envelope = createDispatchEnvelope(state, "design", contract); await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: envelope.eventId, runId: state.runId, phaseId: "design", attempt: 1, role: "leader", callbackTokenHash: envelope.callbackTokenHash }); const result = await handleNativeLifecycleEvent({ projectRoot: root, event: { agent: "leader", status: "done", eventId: "done" } }); assert.equal(result.callbackRequired, true); assert.equal(readStoredWorkflow(root).phases.design.status, "DISPATCHED"); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicate idle event sends one callback pointer reminder", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-event-reminder-")); let prompts = 0;
  try { const contract = compileWorkflowDefinition(loadBuiltInTemplate("development"), { agents: { leader: "leader" } }); const state = await startStoredWorkflow(root, contract); const envelope = createDispatchEnvelope(state, "design", contract); await applyStoredEvent(root, { type: "TURN_DISPATCHED", eventId: envelope.eventId, runId: state.runId, phaseId: "design", attempt: 1, role: "leader", callbackTokenHash: envelope.callbackTokenHash }); const options = { projectRoot: root, request: async () => { prompts += 1; }, event: { agent: "leader", target: "p1", status: "idle", eventId: "idle-1" } }; await handleNativeLifecycleEvent(options); await handleNativeLifecycleEvent(options); assert.equal(prompts, 1); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("callback credentials remain recoverable when lifecycle reminder replaces the dispatch prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-event-recover-callback-"));
  const prompts = [];
  const request = async (method, params) => {
    if (method === "agent.list") return { result: { agents: [{ name: "leader", pane_id: "p1", workspace_id: "w1" }] } };
    if (method === "agent.get") return { result: { status: "idle" } };
    if (method === "agent.prompt") { prompts.push(params.text); return { result: { status: "working" } }; }
    throw new Error(`unexpected method ${method}`);
  };
  try {
    await startNativeWorkflow({ projectRoot: root, template: "development", agents: { leader: "leader" }, requestMarkdown: "Implement it.", request, workspaceId: "w1" });
    const callbackFile = join(root, ".herdr", "workflow", "callbacks", "design-attempt-1.json");
    assert.equal(existsSync(callbackFile), true, "dispatch must persist recoverable callback credentials before prompting the Agent");
    await handleNativeLifecycleEvent({ projectRoot: root, request, event: { agent: "leader", target: "p1", status: "idle", eventId: "idle-after-working" } });
    assert.match(prompts.at(-1), /callback_request_path/);
    const loaded = loadCallbackRequestFromContext(root, { agent_name: "leader" });
    assert.equal(loaded.request.callback_token, JSON.parse(readFileSync(callbackFile, "utf8")).callback_token);
    assert.ok(loaded.request.callback_token);
    assert.doesNotMatch(readFileSync(join(root, ".herdr", "workflow", "events.jsonl"), "utf8"), new RegExp(loaded.request.callback_token));
    assert.doesNotMatch(readFileSync(join(root, ".herdr", "workflow", "state.json"), "utf8"), new RegExp(loaded.request.callback_token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
