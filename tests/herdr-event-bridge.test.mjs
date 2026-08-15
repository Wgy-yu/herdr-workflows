import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleEvent,
  parseEvent,
  routeAgentEvent,
  buildNotification,
  eventKey,
  findAgentTarget,
  normalizeSocketPath,
} from "../herdr-event-bridge.mjs";
import { readWorkflowState, startWorkflow } from "../workflow-state.mjs";

function bridgeFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const project = join(root, "repo");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  writeFileSync(join(project, ".herdr", "workflows.yaml"), [
    "default_workflow: default", "workflows:", "  default:",
    "    leader: codex-leader", "    implementer: opencode", "    reviewer: claude",
  ].join("\n"), "utf8");
  const env = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: "pane_agent_status_changed", pane_id: "w1:p2", workspace_id: "w1", agent: "opencode", agent_status: "done" }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: project, workspace_id: "w1" }),
    HERDR_PLUGIN_ROOT: fileURLToPath(new URL("..", import.meta.url)), USERPROFILE: root,
  };
  return { root, project, env };
}

test("解析 Herdr 0.8 真实 Agent 状态事件并归一化订阅名", () => {
  const event = parseEvent(
    JSON.stringify({
      type: "pane_agent_status_changed",
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent: "opencode",
      agent_status: "done",
      state_change_seq: 17,
    }),
    "pane.agent_status_changed"
  );

  assert.deepEqual(event, {
    eventName: "pane.agent_status_changed",
    paneId: "w1:p2",
    workspaceId: "w1",
    agent: "opencode",
    status: "done",
    revision: 17,
  });
});

test("实施者完成后路由到审查者，审查者完成后路由到 Leader", () => {
  const workflow = { leader: "codex-leader", implementer: "opencode", reviewer: "claude" };

  assert.deepEqual(
    routeAgentEvent(
      { agent: "opencode", status: "done", paneId: "w1:p2", workspaceId: "w1" },
      workflow
    ),
    { fromRole: "implementer", toRole: "reviewer", reason: "implementation_done" }
  );
  assert.deepEqual(
    routeAgentEvent(
      { agent: "claude", status: "done", paneId: "w1:p3", workspaceId: "w1" },
      workflow
    ),
    { fromRole: "reviewer", toRole: "leader", reason: "review_done" }
  );
});

test("阻塞事件直接通知 Leader，未知状态不路由", () => {
  const workflow = { leader: "codex-leader", implementer: "opencode", reviewer: "claude" };

  assert.deepEqual(
    routeAgentEvent(
      { agent: "claude", status: "blocked", paneId: "w1:p3", workspaceId: "w1" },
      workflow
    ),
    { fromRole: "reviewer", toRole: "leader", reason: "review_blocked" }
  );
  assert.equal(
    routeAgentEvent(
      { agent: "opencode", status: "working", paneId: "w1:p2", workspaceId: "w1" },
      workflow
    ),
    null
  );
});

test("通知正文只传共享文件路径，不内联长计划正文", () => {
  const message = buildNotification({
    fromRole: "implementer",
    toRole: "reviewer",
    reason: "implementation_done",
    event: { agent: "opencode", status: "done", paneId: "w1:p2", workspaceId: "w1" },
    ledgerPath: "D:/repo/.herdr/workflow-events.jsonl",
    planPath: "D:/repo/.herdr/workflow-plan.md",
    reviewPath: "D:/repo/.herdr/reviews/run-1.md",
    planContent: "不应进入通知正文".repeat(1000),
  });

  assert.match(message, /实施者/);
  assert.match(message, /审查者/);
  assert.match(message, /workflow-events\.jsonl/);
  assert.match(message, /workflow-plan\.md/);
  assert.match(message, /reviews\/run-1\.md/);
  assert.doesNotMatch(message, /不应进入通知正文/);
  assert.match(message, /不要等待 Leader 转发/);
  assert.ok(Buffer.byteLength(message, "utf8") < 1000);
});

test("事件键优先使用 Herdr 状态序号，避免重复通知", () => {
  assert.equal(
    eventKey({ workspaceId: "w1", paneId: "w1:p2", status: "done", revision: 12 }),
    "w1:w1:p2:done:12"
  );
  assert.equal(
    eventKey(
      { workspaceId: "w1", paneId: "w1:p2", agent: "opencode", status: "done" },
      "IMPLEMENTATION_RUNNING",
      "run-1"
    ),
    "run-1:w1:w1:p2:opencode:done:IMPLEMENTATION_RUNNING"
  );
});

test("没有先观察到 working 时，idle 不得路由", () => {
  const workflow = { leader: "codex-leader", implementer: "opencode", reviewer: "claude" };
  assert.equal(
    routeAgentEvent(
      { agent: "opencode", status: "idle", paneId: "w1:p2", workspaceId: "w1" },
      workflow,
      { observedWorking: false }
    ),
    null
  );
  assert.deepEqual(
    routeAgentEvent(
      { agent: "opencode", status: "idle", paneId: "w1:p2", workspaceId: "w1" },
      workflow,
      { observedWorking: true }
    ),
    { fromRole: "implementer", toRole: "reviewer", reason: "implementation_done" }
  );
});

test("Windows Herdr socket 标记路径归一化为命名管道地址", () => {
  assert.equal(
    normalizeSocketPath("C:\\Users\\wgy\\AppData\\Roaming\\herdr\\herdr.sock", "win32"),
    "\\\\.\\pipe\\C:\\Users\\wgy\\AppData\\Roaming\\herdr\\herdr.sock"
  );
  assert.equal(
    normalizeSocketPath("\\\\.\\pipe\\C:\\Users\\wgy\\AppData\\Roaming\\herdr\\herdr.sock", "win32"),
    "\\\\.\\pipe\\C:\\Users\\wgy\\AppData\\Roaming\\herdr\\herdr.sock"
  );
  assert.equal(normalizeSocketPath("/tmp/herdr.sock", "linux"), "/tmp/herdr.sock");
});

test("按工作区和 Agent 名称找到目标 pane", () => {
  const agents = [
    { name: "claude", agent: "claude", pane_id: "w2:p3", workspace_id: "w2" },
    { name: "claude", agent: "claude", pane_id: "w1:p3", workspace_id: "w1" },
  ];
  assert.equal(findAgentTarget(agents, "claude", "w1"), "w1:p3");
  assert.equal(findAgentTarget(agents, "missing", "w1"), null);
  assert.equal(findAgentTarget(agents, "claude", "w3"), null);
  assert.equal(findAgentTarget([{ name: "claude", pane_id: "p3" }], "claude", "w1"), null);
});

test("无 revision 的事件键包含 runId，下一轮不会碰撞", () => {
  const event = { workspaceId: "w1", paneId: "w1:p2", agent: "opencode", status: "done" };
  assert.notEqual(
    eventKey(event, "IMPLEMENTATION_RUNNING", "run-1"),
    eventKey(event, "IMPLEMENTATION_RUNNING", "run-2")
  );
});

test("事件处理通过官方 agent.prompt 直达下一角色并写入共享记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflows-bridge-"));
  const project = join(root, "repo");
  const configDir = join(project, ".herdr");
  const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
  const calls = [];
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true }));
    writeFileSync(
      join(configDir, "workflows.yaml"),
      [
        "default_workflow: default",
        "workflows:",
        "  default:",
        "    leader: codex-leader",
        "    implementer: opencode",
        "    reviewer: claude",
      ].join("\n"),
      "utf8"
    );
    writeFileSync(join(configDir, "workflow-plan.md"), "# 本轮真实计划\n\n只审查当前工作树。", "utf8");
    startWorkflow(project, "default");
    const result = await handleEvent({
      env: {
        HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          type: "pane_agent_status_changed",
          pane_id: "w1:p2",
          workspace_id: "w1",
          agent: "opencode",
          agent_status: "done",
        }),
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ cwd: project, workspace_id: "w1" }),
        HERDR_PLUGIN_ROOT: pluginRoot,
        USERPROFILE: root,
      },
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "agent.list") {
          return {
            result: {
              agents: [
                { name: "opencode", pane_id: "w1:p2", workspace_id: "w1" },
                { name: "claude", pane_id: "w1:p3", workspace_id: "w1" },
              ],
            },
          };
        }
        return { result: { ok: true } };
      },
    });

    assert.equal(result.delivery, "agent.prompt");
    assert.equal(calls.some((call) => call.method === "agent.prompt" && call.params.target === "w1:p3"), true);
    const reviewerPrompt = calls.find((call) => call.method === "agent.prompt");
    assert.match(reviewerPrompt.params.text, /workflow-plan\.md/);
    assert.match(reviewerPrompt.params.text, /\.herdr[\\/]reviews[\\/].+\.md/);
    assert.doesNotMatch(reviewerPrompt.params.text, /只审查当前工作树/);
    const ledger = readFileSync(join(configDir, "workflow-events.jsonl"), "utf8");
    assert.match(ledger, /implementation_done/);
    assert.match(ledger, /agent\.prompt/);
    assert.equal(readWorkflowState(project).status, "REVIEW_RUNNING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未通过 dispatch 启动时 done 事件不能推进工作流", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-workflows-bridge-state-"));
  const project = join(root, "repo");
  const configDir = join(project, ".herdr");
  const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
  const calls = [];
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true }));
    writeFileSync(
      join(configDir, "workflows.yaml"),
      [
        "default_workflow: default",
        "workflows:",
        "  default:",
        "    leader: codex-leader",
        "    implementer: opencode",
        "    reviewer: claude",
      ].join("\n"),
      "utf8"
    );
    const result = await handleEvent({
      env: {
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          type: "pane_agent_status_changed",
          pane_id: "w1:p2",
          workspace_id: "w1",
          agent: "opencode",
          agent_status: "done",
        }),
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ cwd: project, workspace_id: "w1" }),
        HERDR_PLUGIN_ROOT: pluginRoot,
        USERPROFILE: root,
      },
      request: async (method) => {
        calls.push(method);
        if (method === "agent.list") {
          return { result: { agents: [{ name: "opencode", pane_id: "w1:p2", workspace_id: "w1" }] } };
        }
        return { result: { ok: true } };
      },
    });
    assert.equal(result.reason, "workflow-state-not-routable");
    assert.equal(calls.includes("agent.prompt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("审核结果文件缺失时留在审查阶段并短消息唤回审核者", async () => {
  const fixture = bridgeFixture("herdr-workflows-review-output-");
  const calls = [];
  try {
    startWorkflow(fixture.project, "default");
    const request = async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.list") return { result: { agents: [
        { name: "opencode", pane_id: "w1:p2", workspace_id: "w1" },
        { name: "claude", pane_id: "w1:p3", workspace_id: "w1" },
        { name: "codex-leader", pane_id: "w1:p1", workspace_id: "w1" },
      ] } };
      return { result: { ok: true } };
    };
    await handleEvent({ env: fixture.env, request });
    assert.equal(readWorkflowState(fixture.project).status, "REVIEW_RUNNING");

    const reviewEvent = {
      ...fixture.env,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        type: "pane_agent_status_changed",
        pane_id: "w1:p3",
        workspace_id: "w1",
        agent: "claude",
        agent_status: "done",
      }),
    };
    const missing = await handleEvent({ env: reviewEvent, request });
    assert.equal(missing.reason, "review-output-missing");
    assert.equal(readWorkflowState(fixture.project).status, "REVIEW_RUNNING");
    const retryPrompt = calls.filter((call) => call.method === "agent.prompt").at(-1);
    assert.equal(retryPrompt.params.target, "w1:p3");
    assert.match(retryPrompt.params.text, /审核结果文件/);

    const state = readWorkflowState(fixture.project);
    const reviewDir = join(fixture.project, ".herdr", "reviews");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, `${state.runId}.md`), "REVIEW_PASS", "utf8");
    const delivered = await handleEvent({ env: reviewEvent, request });
    assert.equal(delivered.workflowStatus, "FINAL_DECISION_PENDING");
    const leaderPrompt = calls.filter((call) => call.method === "agent.prompt").at(-1);
    assert.equal(leaderPrompt.params.target, "w1:p1");
    assert.match(leaderPrompt.params.text, new RegExp(`${state.runId}\\.md`));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("同一聚焦 pane 的 working 到 idle 会自动通知下一角色", async () => {
  const fixture = bridgeFixture("herdr-workflows-idle-");
  const calls = [];
  try {
    startWorkflow(fixture.project, "default");
    const request = async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.list") return { result: { agents: [
        { name: "opencode", pane_id: "w1:p2", workspace_id: "w1" },
        { name: "claude", pane_id: "w1:p3", workspace_id: "w1" },
      ] } };
      return { result: { ok: true } };
    };
    const working = await handleEvent({
      env: { ...fixture.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: "pane_agent_status_changed", pane_id: "w1:p2", workspace_id: "w1", agent: "opencode", agent_status: "working" }) },
      request,
    });
    assert.equal(working.reason, "working-observed");
    assert.equal(readWorkflowState(fixture.project).status, "IMPLEMENTATION_RUNNING");
    const idle = await handleEvent({
      env: { ...fixture.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: "pane_agent_status_changed", pane_id: "w1:p2", workspace_id: "w1", agent: "opencode", agent_status: "idle" }) },
      request,
    });
    assert.equal(idle.handled, true);
    assert.equal(idle.workflowStatus, "REVIEW_RUNNING");
    assert.equal(calls.some((call) => call.method === "agent.prompt" && call.params.target === "w1:p3"), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("agent.prompt 失败时不推进状态且相同事件可以重放", async () => {
  const fixture = bridgeFixture("herdr-workflows-replay-");
  let promptAttempts = 0;
  try {
    startWorkflow(fixture.project, "default");
    const request = async (method) => {
      if (method === "agent.list") return { result: { agents: [
        { name: "opencode", pane_id: "w1:p2", workspace_id: "w1" },
        { name: "claude", pane_id: "w1:p3", workspace_id: "w1" },
      ] } };
      if (method === "agent.prompt" && ++promptAttempts === 1) throw new Error("socket closed");
      return { result: { ok: true } };
    };
    const failed = await handleEvent({ env: fixture.env, request });
    assert.equal(failed.reason, "delivery-failed");
    assert.equal(readWorkflowState(fixture.project).status, "IMPLEMENTATION_RUNNING");
    const replayed = await handleEvent({ env: fixture.env, request });
    assert.equal(replayed.handled, true);
    assert.equal(readWorkflowState(fixture.project).status, "REVIEW_RUNNING");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("并发重复事件只投递并提交一次", async () => {
  const fixture = bridgeFixture("herdr-workflows-concurrent-");
  let prompts = 0;
  try {
    startWorkflow(fixture.project, "default");
    const request = async (method) => {
      if (method === "agent.list") return { result: { agents: [
        { name: "opencode", pane_id: "w1:p2", workspace_id: "w1" },
        { name: "claude", pane_id: "w1:p3", workspace_id: "w1" },
      ] } };
      if (method === "agent.prompt") {
        prompts += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      return { result: { ok: true } };
    };
    const results = await Promise.all([
      handleEvent({ env: fixture.env, request }),
      handleEvent({ env: fixture.env, request }),
    ]);
    assert.equal(prompts, 1);
    assert.equal(results.filter((result) => result.handled).length, 1);
    assert.equal(readWorkflowState(fixture.project).status, "REVIEW_RUNNING");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
