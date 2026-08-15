import test from "node:test";
import assert from "node:assert/strict";
import { selectExecutionAdapter, startAgentTurn } from "../herdr-agent-adapter.mjs";

test("turn start uses one deadline and waits for working", async () => {
  const calls = [];
  const result = await startAgentTurn({ target: "worker", text: "pointer", timeoutMs: 120000 }, async (method, params) => {
    calls.push({ method, params });
    return method === "agent.get" ? { result: { status: "idle" } } : { result: { status: "working" } };
  });
  assert.equal(result.status, "TURN_STARTED");
  assert.deepEqual(calls.map((call) => call.method), ["agent.get", "agent.prompt"]);
  assert.deepEqual(calls[1].params.until, ["working"]);
  assert.ok(calls[1].params.timeout > 0 && calls[1].params.timeout <= 120000);
});

test("already working is uncertain and is never prompted", async () => {
  const calls = [];
  const result = await startAgentTurn({ target: "worker", text: "pointer" }, async (method) => { calls.push(method); return { result: { status: "working" } }; });
  assert.equal(result.status, "DELIVERY_UNKNOWN");
  assert.deepEqual(calls, ["agent.get"]);
});

test("goal is optional capability with ordinary-turn fallback", () => {
  assert.deepEqual(selectExecutionAdapter({ goal: true }, "goal"), { kind: "goal", fallback: false });
  assert.deepEqual(selectExecutionAdapter({}, "goal"), { kind: "turn", fallback: true });
});
