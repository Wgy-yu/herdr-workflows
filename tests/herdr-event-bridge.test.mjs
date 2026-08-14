import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "../herdr-event-bridge.mjs";
import { readWorkflowState, startWorkflow } from "../workflow-state.mjs";

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

test("通知正文明确要求目标 Agent 读取共享状态并继续", () => {
  const message = buildNotification({
    fromRole: "implementer",
    toRole: "reviewer",
    reason: "implementation_done",
    event: { agent: "opencode", status: "done", paneId: "w1:p2", workspaceId: "w1" },
    ledgerPath: "D:/repo/.herdr/workflow-events.jsonl",
  });

  assert.match(message, /实施者/);
  assert.match(message, /审查者/);
  assert.match(message, /workflow-events\.jsonl/);
  assert.match(message, /不要等待 Leader 转发/);
});

test("事件键优先使用 Herdr 状态序号，避免重复通知", () => {
  assert.equal(
    eventKey({ workspaceId: "w1", paneId: "w1:p2", status: "done", revision: 12 }),
    "w1:w1:p2:done:12"
  );
  assert.equal(
    eventKey(
      { workspaceId: "w1", paneId: "w1:p2", agent: "opencode", status: "done" },
      "IMPLEMENTATION_RUNNING"
    ),
    "w1:w1:p2:opencode:done:IMPLEMENTATION_RUNNING"
  );
});

test("按工作区和 Agent 名称找到目标 pane", () => {
  const agents = [
    { name: "claude", agent: "claude", pane_id: "w2:p3", workspace_id: "w2" },
    { name: "claude", agent: "claude", pane_id: "w1:p3", workspace_id: "w1" },
  ];
  assert.equal(findAgentTarget(agents, "claude", "w1"), "w1:p3");
  assert.equal(findAgentTarget(agents, "missing", "w1"), null);
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
