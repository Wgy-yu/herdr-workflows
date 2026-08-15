# Native Event-Driven Orchestration Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed two-stage workflow with a single-active, template-driven Herdr orchestration engine that supports constrained custom workflows, structured callbacks, parallel frontend/backend execution, recovery, and shared do/goal contracts.

**Architecture:** Compile YAML templates into an immutable contract, apply structured events through a pure reducer, and persist append-only events plus atomic projections under `.herdr/workflow/`. Herdr Actions and lifecycle hooks adapt Agent signals into engine events; lifecycle state wakes the engine but never proves semantic completion without a validated callback and report.

**Tech Stack:** Node.js ESM, `node:test`, bundled `js-yaml`, Markdown Skills, Herdr plugin manifest/Actions/events.

## Global Constraints

- One repository may have only one active workflow; parallelism is allowed only inside that workflow.
- `do` and `goal` share one contract and cannot run concurrently.
- Do not read or migrate legacy `.herdr/workflow-state.json`, `.herdr/workflow-plan.md`, or `.herdr/workflow-events.jsonl`.
- Reviewer business-source read-only, structured callbacks, scope checks, bounded rework, and Leader/human final decision cannot be disabled.
- Every wait and Herdr subprocess uses one absolute deadline; never issue an unbounded `agent.wait`.
- `idle`, `done`, and `unknown` never prove semantic completion.
- Automatic transitions stop after 8 hops.
- Do not add a daemon, SQLite, a Rust runtime, or arbitrary shell execution from workflow YAML.
- Check source-project licenses before copying code; implement repository-native code rather than copying reference implementations.

---

## File Structure

- Create `workflow-definition.mjs`: built-in definitions, YAML normalization, graph validation, and immutable contract compilation.
- Create `workflow-engine.mjs`: workflow/phase state types and pure `reduceWorkflow(state, event, contract)` transition logic.
- Create `workflow-store.mjs`: new directory layout, lock, atomic writes, append-only events, report validation, replay, and repair.
- Create `workflow-protocol.mjs`: callback envelope validation, callback tokens, report paths, and short dispatch messages.
- Create `herdr-agent-adapter.mjs`: absolute-deadline Herdr requests, new-turn evidence, lifecycle normalization, and Goal capability selection.
- Create `herdr-workflow-callback.mjs`: plugin Action entrypoint for validated Agent callbacks.
- Replace `workflow-state.mjs`: compatibility exports backed only by the new engine/store, without legacy file reads.
- Modify `herdr-workflow-dispatch.mjs`: compile/start a contract and dispatch all initially-ready phases.
- Modify `herdr-event-bridge.mjs`: wake/check phases from lifecycle events without semantic auto-completion.
- Modify `herdr-plugin.toml`: register start/dispatch/callback/repair Actions and keep the lifecycle event.
- Create `skills/herdr-workflows/assets/templates/{development,frontend-backend,review-only}.yaml`.
- Modify configuration schema, defaults, core Skill, README, VERSION, and focused tests.

---

### Task 1: Compile Built-In and Custom Workflow Definitions

**Files:**
- Create: `workflow-definition.mjs`
- Create: `skills/herdr-workflows/assets/templates/development.yaml`
- Create: `skills/herdr-workflows/assets/templates/frontend-backend.yaml`
- Create: `skills/herdr-workflows/assets/templates/review-only.yaml`
- Create: `tests/workflow-definition.test.mjs`

**Interfaces:**
- Consumes: `parseYamlFile(path)` from `skills/herdr-workflows/scripts/config-tool.mjs`.
- Produces: `compileWorkflowDefinition(definition, overrides?) -> Contract`; `loadBuiltInTemplate(name) -> object`; `validateWorkflowDefinition(definition) -> string[]`.
- Contract fields: `{ version: 1, workflowId, template, roles, phases, finalPhaseId, maxAutoHops: 8, maxRework, compiledAt }`.

- [ ] **Step 1: Write failing compiler tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowDefinition, loadBuiltInTemplate } from "../workflow-definition.mjs";

test("frontend-backend compiles parallel implementers into an explicit join", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"), {
    agents: { leader: "codex", frontend: "claude", backend: "opencode", reviewer: "pi" },
  });
  assert.deepEqual(contract.phases.integration_review.needs.sort(), ["backend_implement", "frontend_implement"]);
  assert.equal(contract.roles.reviewer.readOnly, true);
  assert.equal(contract.maxAutoHops, 8);
});

test("custom definitions cannot overlap parallel write scopes", () => {
  const definition = loadBuiltInTemplate("frontend-backend");
  definition.roles.frontend.writable_paths = ["src/**"];
  definition.roles.backend.writable_paths = ["src/**"];
  assert.throws(() => compileWorkflowDefinition(definition), /并行写路径重叠/);
});
```

- [ ] **Step 2: Run compiler tests and verify RED**

Run: `node --test tests/workflow-definition.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `workflow-definition.mjs`.

- [ ] **Step 3: Add the three concrete YAML templates**

The `frontend-backend.yaml` graph must contain `design`, parallel `frontend_implement` and `backend_implement`, `integration_review`, `rework`, `verify`, and `decision`. The development and review-only templates must end at the same protected `decision` phase.

- [ ] **Step 4: Implement minimal normalization and validation**

Implement exact checks for non-empty unique phase IDs, known roles/dependencies, acyclic `needs`, explicit joins, non-overlapping parallel `writable_paths`, non-empty `required_tests` on implementation phases, read-only reviewers, bounded rework, structured callbacks, and one final Leader decision.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/workflow-definition.test.mjs`

Expected: all compiler/template tests PASS.

- [ ] **Step 6: Commit the compiler and templates**

```powershell
git add workflow-definition.mjs tests/workflow-definition.test.mjs skills/herdr-workflows/assets/templates
git commit -m "feat: compile constrained orchestration workflow templates" -m "Add development, review-only, and parallel frontend-backend definitions. Validate immutable safety gates, DAG dependencies, joins, write scopes, required tests, and final Leader decisions before a workflow can start."
```

---

### Task 2: Add the Pure Reducer and Parallel Join Semantics

**Files:**
- Create: `workflow-engine.mjs`
- Create: `tests/workflow-engine.test.mjs`

**Interfaces:**
- Consumes: compiled `Contract` from Task 1.
- Produces: `createWorkflowState(contract, entryMode) -> WorkflowState`; `reduceWorkflow(state, event, contract) -> { state, effects, accepted }`; `readyPhaseIds(state, contract) -> string[]`.
- Event envelope: `{ type, eventId, runId, phaseId, attempt, role, inReplyTo, callbackTokenHash, payload }`.
- Effect variants: `DISPATCH_PHASE`, `NOTIFY_LEADER`, `VALIDATE_REPORT`, `BLOCK_WORKFLOW`, `FINALIZE_WORKFLOW`.

- [ ] **Step 1: Write failing reducer tests**

```js
test("parallel branches join only after both structured completions", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"));
  let state = createWorkflowState(contract, "do");
  ({ state } = reduceWorkflow(state, started("frontend_implement"), contract));
  ({ state } = reduceWorkflow(state, completed("frontend_implement"), contract));
  assert.equal(state.phases.integration_review.status, "PENDING");
  ({ state } = reduceWorkflow(state, started("backend_implement"), contract));
  const result = reduceWorkflow(state, completed("backend_implement"), contract);
  assert.equal(result.state.phases.integration_review.status, "READY");
  assert.deepEqual(result.effects.map((effect) => effect.type), ["DISPATCH_PHASE"]);
});

test("the ninth automatic hop blocks the workflow", () => {
  const state = fixtureState({ automaticHops: 8 });
  const result = reduceWorkflow(state, validAutomaticCompletion(), fixtureContract());
  assert.equal(result.state.status, "BLOCKED");
  assert.equal(result.state.lastError.code, "AUTO_HOP_LIMIT");
});
```

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `node --test tests/workflow-engine.test.mjs`

Expected: FAIL because `workflow-engine.mjs` does not exist.

- [ ] **Step 3: Implement the minimal reducer**

Use plain objects and frozen contract input. Reject wrong run/phase/attempt/role, duplicates, illegal predecessor states, and terminal-state mutations. Set parallel children READY together; set join READY only when every dependency is APPROVED. Rework creates a new attempt and supersedes the accepted prior report.

- [ ] **Step 4: Add rejection and terminal-path cases**

Cover duplicate `eventId`, old `runId`, old attempt, missing `inReplyTo`, branch `BLOCKED`, rework limit, `FINAL_DECISION` pass/reject, and `unknown` lifecycle events producing no semantic transition.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/workflow-engine.test.mjs`

Expected: all reducer tests PASS.

- [ ] **Step 6: Commit the reducer**

```powershell
git add workflow-engine.mjs tests/workflow-engine.test.mjs
git commit -m "feat: add pure orchestration reducer with parallel joins" -m "Model workflow and phase lifecycles, enforce structured event correlation and rework limits, converge frontend/backend branches at an explicit join, and block runaway automatic transitions after eight hops."
```

---

### Task 3: Build the Atomic Store, Event Replay, and Repair

**Files:**
- Create: `workflow-store.mjs`
- Create: `tests/workflow-store.test.mjs`
- Replace: `workflow-state.mjs`
- Modify: `tests/workflow-state.test.mjs`

**Interfaces:**
- Consumes: state/reducer from Task 2.
- Produces: `startStoredWorkflow(root, contract, mode)`; `applyStoredEvent(root, event)`; `readStoredWorkflow(root)`; `writeStageReport(root, envelope, markdown)`; `replayWorkflow(root)`; `repairWorkflow(root)`; `withWorkflowLock(root, operation)`.
- Storage root is exactly `<root>/.herdr/workflow/`.

- [ ] **Step 1: Write failing storage tests**

```js
test("new engine ignores legacy state files", () => {
  writeFileSync(join(root, ".herdr", "workflow-state.json"), JSON.stringify({ status: "BLOCKED" }));
  const state = startStoredWorkflow(root, contract, "do");
  assert.equal(state.status, "RUNNING");
  assert.equal(existsSync(join(root, ".herdr", "workflow", "state.json")), true);
});

test("replay detects a corrupted state projection", () => {
  startStoredWorkflow(root, contract, "do");
  writeFileSync(join(root, ".herdr", "workflow", "state.json"), "{}\n");
  assert.throws(() => replayWorkflow(root), /STATE_PROJECTION_MISMATCH/);
  assert.equal(repairWorkflow(root).status, "RUNNING");
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Run: `node --test tests/workflow-store.test.mjs tests/workflow-state.test.mjs`

Expected: FAIL because the new store exports are missing.

- [ ] **Step 3: Implement new directory and lock semantics**

Write `definition.yaml`, `contract.json`, `events.jsonl`, `state.json`, `phases/*.json`, and `reports/*.md` only beneath `.herdr/workflow/`. Lock metadata must include PID, token, operation, and acquisition time. Reclaim only a dead PID or an expired unchanged lock; validate the resolved storage path before mutation.

- [ ] **Step 4: Implement ordered commit and replay**

Under one lock: validate/write report artifact, append one event line, reduce, atomically replace phase projections, then atomically replace `state.json`. Replay starts from `WORKFLOW_CREATED` and all accepted events. Repair replaces projections only after a full successful replay.

- [ ] **Step 5: Add concurrency, crash, and path-safety tests**

Run simultaneous identical events and assert one acceptance; simulate failure before and after event append; cover dead-lock takeover, symlink/path traversal report rejection, immutable accepted report names, and monotonically increasing sequence values.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/workflow-store.test.mjs tests/workflow-state.test.mjs`

Expected: all store/replay/compatibility tests PASS.

- [ ] **Step 7: Commit the store migration**

```powershell
git add workflow-store.mjs workflow-state.mjs tests/workflow-store.test.mjs tests/workflow-state.test.mjs
git commit -m "feat: persist orchestration events and recoverable projections" -m "Switch directly to .herdr/workflow, serialize mutations with fenced locks, atomically persist reports and state, replay append-only events, repair projections explicitly, and reject legacy-state reads and path escapes."
```

---

### Task 4: Validate Structured Callbacks and Reports

**Files:**
- Create: `workflow-protocol.mjs`
- Create: `herdr-workflow-callback.mjs`
- Create: `tests/workflow-protocol.test.mjs`
- Create: `tests/herdr-workflow-callback.test.mjs`

**Interfaces:**
- Consumes: `applyStoredEvent`, `writeStageReport`, current contract/state.
- Produces: `createDispatchEnvelope(state, phase, contract)`; `validateCallbackEnvelope(envelope, state, contract)`; `formatDispatchMessage(envelope)`; callback Action `handleCallback(options)`.
- Callback Action parameters: `{ workflow_id, run_id, phase_id, event_id, attempt, role, in_reply_to, callback_token, type, report_markdown, payload }`.

- [ ] **Step 1: Write failing protocol tests**

```js
test("a callback requires the current one-time token and predecessor event", () => {
  const valid = callbackFixture();
  assert.equal(validateCallbackEnvelope(valid, state, contract).valid, true);
  assert.match(validateCallbackEnvelope({ ...valid, callback_token: "wrong" }, state, contract).error, /CALLBACK_TOKEN_INVALID/);
  assert.match(validateCallbackEnvelope({ ...valid, in_reply_to: "old" }, state, contract).error, /CALLBACK_CAUSATION_INVALID/);
});

test("dispatch messages contain pointers and correlation metadata, not contract bodies", () => {
  const text = formatDispatchMessage(dispatchFixture());
  assert.match(text, /workflow_id=/);
  assert.match(text, /contract_path=/);
  assert.doesNotMatch(text, /required_tests.*\[/s);
  assert.ok(Buffer.byteLength(text, "utf8") < 1500);
});
```

- [ ] **Step 2: Run protocol tests and verify RED**

Run: `node --test tests/workflow-protocol.test.mjs tests/herdr-workflow-callback.test.mjs`

Expected: FAIL because protocol and callback modules do not exist.

- [ ] **Step 3: Implement tokens, validation, and bounded reports**

Generate a random callback token per attempt and persist only its SHA-256 hash in phase state. Compare hashes with `timingSafeEqual`. Limit Markdown reports to 256 KiB, require non-empty text, derive the report path internally, and never accept a caller-supplied filesystem path.

- [ ] **Step 4: Implement callback Action handling**

Parse Herdr Action context, locate the project, validate every correlation field, atomically save the report, apply the event, and return JSON. Invalid callbacks append a `CALLBACK_REJECTED` audit event without changing semantic phase state.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/workflow-protocol.test.mjs tests/herdr-workflow-callback.test.mjs`

Expected: all callback/protocol tests PASS.

- [ ] **Step 6: Commit the structured callback boundary**

```powershell
git add workflow-protocol.mjs herdr-workflow-callback.mjs tests/workflow-protocol.test.mjs tests/herdr-workflow-callback.test.mjs
git commit -m "feat: require authenticated structured workflow callbacks" -m "Correlate every report to workflow, run, phase, attempt, role, and predecessor event; use one-time hashed callback tokens; atomically store bounded reports; and audit invalid or duplicate submissions without advancing state."
```

---

### Task 5: Adapt Herdr Dispatch and Lifecycle Events

**Files:**
- Create: `herdr-agent-adapter.mjs`
- Create: `herdr-workflow-repair.mjs`
- Create: `tests/herdr-agent-adapter.test.mjs`
- Modify: `herdr-workflow-dispatch.mjs`
- Modify: `herdr-event-bridge.mjs`
- Modify: `tests/herdr-workflow-dispatch.test.mjs`
- Modify: `tests/herdr-event-bridge.test.mjs`
- Modify: `herdr-plugin.toml`

**Interfaces:**
- Consumes: contract/store/protocol modules from Tasks 1-4 and injected `request(method, params)` used by existing tests.
- Produces: `dispatchReadyPhases(root, request)`; `startAgentTurn({ target, text, timeoutMs }, request)`; `selectExecutionAdapter(agentCapabilities, mode)`; lifecycle `handleEvent(options)` that records evidence and checks callbacks without semantic completion.

- [ ] **Step 1: Write failing adapter tests**

```js
test("turn start uses one deadline and requires a new working observation", async () => {
  const calls = [];
  const outcome = await startAgentTurn({ target: "worker", text: "path only", timeoutMs: 120000 }, scriptedRequest(calls));
  assert.equal(outcome.status, "TURN_STARTED");
  assert.deepEqual(calls.map((call) => call.method), ["agent.get", "agent.prompt"]);
  assert.equal(calls[1].params.until, "working");
  assert.ok(calls[1].params.timeout > 0 && calls[1].params.timeout <= 120000);
});

test("an already-working target returns DELIVERY_UNKNOWN without prompting", async () => {
  const calls = [];
  const outcome = await startAgentTurn({ target: "worker", text: "path only", timeoutMs: 120000 }, workingRequest(calls));
  assert.equal(outcome.status, "DELIVERY_UNKNOWN");
  assert.deepEqual(calls.map((call) => call.method), ["agent.get"]);
});
```

- [ ] **Step 2: Run adapter/bridge tests and verify RED**

Run: `node --test tests/herdr-agent-adapter.test.mjs tests/herdr-workflow-dispatch.test.mjs tests/herdr-event-bridge.test.mjs`

Expected: FAIL because new adapter behavior is absent.

- [ ] **Step 3: Implement absolute-deadline Agent operations**

Read status first. Never prompt an already-working Agent. Use `agent.prompt` with `wait: true`, `until: ["working"]`, and remaining timeout. Map stalled/timeout/lost response to `DELIVERY_UNKNOWN`; map blocked explicitly; never retry automatically. Goal mode selects Goal only when capability is verified and otherwise records ordinary-turn fallback.

- [ ] **Step 4: Replace fixed dispatch with ready-phase fan-out**

Compile/start the selected template, resolve every READY role in the current workspace, and dispatch all ready phases. Commit `TURN_DISPATCHED` before sending, then accept `TURN_STARTED` evidence. Partial fan-out failure leaves successful branches running and blocks undispatched branches for explicit recovery.

- [ ] **Step 5: Make lifecycle events non-semantic**

`working` records turn-start evidence. `idle/done` checks whether the expected structured callback/report exists; without it, keep the phase unchanged and send one idempotent pointer notification. `blocked` records phase/workflow block. `unknown` only records diagnostics.

- [ ] **Step 6: Register plugin Actions**

Keep `dispatch`, add `callback` invoking `herdr-workflow-callback.mjs`, and add `repair` invoking a small `herdr-workflow-repair.mjs` wrapper around `repairWorkflow`. Raise the plugin version and minimum Herdr version only if the verified Action schema requires it.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `node --test tests/herdr-agent-adapter.test.mjs tests/herdr-workflow-dispatch.test.mjs tests/herdr-event-bridge.test.mjs tests/herdr-workflow-callback.test.mjs`

Expected: all adapter, dispatch, lifecycle, and callback tests PASS.

- [ ] **Step 8: Commit Herdr integration changes**

```powershell
git add herdr-agent-adapter.mjs herdr-workflow-dispatch.mjs herdr-event-bridge.mjs herdr-workflow-callback.mjs herdr-workflow-repair.mjs herdr-plugin.toml tests/herdr-agent-adapter.test.mjs tests/herdr-workflow-dispatch.test.mjs tests/herdr-event-bridge.test.mjs
git commit -m "feat: drive orchestration phases through Herdr events and callbacks" -m "Dispatch all ready branches with bounded new-turn evidence, treat lifecycle events as wakeups rather than semantic completion, support verified Goal capability with ordinary-turn fallback, expose callback and repair Actions, and preserve explicit recovery after uncertain delivery."
```

---

### Task 6: Expose Template Configuration and Update Skills

**Files:**
- Modify: `skills/herdr-workflows/scripts/config-tool.mjs`
- Modify: `tests/config-tool.test.mjs`
- Modify: `skills/herdr-workflows/assets/defaults.yaml`
- Modify: `skills/herdr-workflows/references/config-schema.md`
- Modify: `skills/herdr-workflows/references/agent-adapters.yaml`
- Modify: `skills/herdr-workflows/SKILL.md`
- Modify: `skills/workflow/SKILL.md`
- Modify: `skills/do/SKILL.md`
- Modify: `skills/goal/SKILL.md`
- Modify: `tests/goal-mode.test.mjs`
- Modify: `README.md`
- Modify: `VERSION`

**Interfaces:**
- Consumes: templates and runtime interfaces from Tasks 1-5.
- Produces: project YAML support for `template`, `roles`, `phases`, capability declarations, `max_rework`, and do/goal entry documentation.

- [ ] **Step 1: Write failing configuration and Skill contract tests**

Add tests that parse a custom DAG, reject disabled safety gates, merge Agent replacements over an internal template, preserve unknown fields, expose `frontend-backend`, document callback/repair Actions, and assert do/goal share `.herdr/workflow/contract.json` while remaining mutually exclusive.

- [ ] **Step 2: Run config/Skill tests and verify RED**

Run: `node --test tests/config-tool.test.mjs tests/goal-mode.test.mjs`

Expected: FAIL because template/role/phase/capability fields are not normalized or documented.

- [ ] **Step 3: Extend configuration normalization**

Normalize snake_case YAML into the exact compiler shape without executing commands. Preserve unknown fields, continue rejecting secrets and project absolute executable paths, and reject any explicit attempt to disable protected gates.

- [ ] **Step 4: Update core Skill and README**

Remove duplicated do/goal business-loop prose. Define one common orchestration protocol and two execution adapters. Document templates, custom YAML, frontend/backend write scopes, structured callback usage, direct storage cutover, recovery/repair, Goal fallback, and the eight-hop limit.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/config-tool.test.mjs tests/goal-mode.test.mjs`

Expected: all config and Skill contract tests PASS.

- [ ] **Step 6: Commit configuration and documentation**

```powershell
git add skills README.md VERSION tests/config-tool.test.mjs tests/goal-mode.test.mjs
git commit -m "docs: expose orchestration templates and custom workflow contracts" -m "Document and validate development, review-only, and parallel frontend-backend templates; allow constrained custom DAGs and Agent replacement; consolidate do/goal rules around one protected contract; and describe callback, recovery, and storage behavior."
```

---

### Task 7: End-to-End Verification and Release Consistency

**Files:**
- Create: `tests/orchestration-e2e.test.mjs`
- Modify: `README.md` only if verification exposes a factual mismatch.
- Modify: `herdr-plugin.toml` or `VERSION` only if release metadata is inconsistent.

**Interfaces:**
- Consumes: complete engine and plugin entrypoints.
- Produces: repository-level verification evidence for one development run, one frontend/backend join, one review-only run, and one recovery run.

- [ ] **Step 1: Write failing end-to-end tests before final glue**

Use temporary Git repositories and injected Herdr socket requests. Assert file layout, fan-out targets, callback correlation, join behavior, Reviewer report-only writes, Leader final decision, do/goal mutual exclusion, and event replay after a simulated process restart.

- [ ] **Step 2: Run E2E tests and verify RED**

Run: `node --test tests/orchestration-e2e.test.mjs`

Expected: at least one integration assertion FAILS for missing final glue; if it passes immediately, strengthen the test to cover the unverified boundary rather than changing production code.

- [ ] **Step 3: Add only the minimal integration glue required for GREEN**

Do not add new features. Fix interface mismatches among compiler, reducer, store, protocol, and adapter while preserving the documented contracts.

- [ ] **Step 4: Run the complete Node test suite**

Run: `node --test tests/*.test.mjs`

Expected: all tests PASS with zero failures, skips, or warnings attributable to the change.

- [ ] **Step 5: Run PowerShell Agent checks**

Run: `powershell -ExecutionPolicy Bypass -File tests/run-check-agents-tests.ps1`

Expected: `CHECK_AGENTS_TESTS_PASS`. If Windows PowerShell 5.1 still reports the pre-existing JSON-array count issue, capture it as an unresolved verification failure and do not claim the full suite passes.

- [ ] **Step 6: Run repository and packaging checks**

Run: `git diff --check`

Run: `node skills/herdr-workflows/scripts/config-tool.mjs validate --scope project --file tests/fixtures/project.yaml`

Run: `git status --short`

Expected: no whitespace errors; fixture validation succeeds; status lists only intentional implementation and test files.

- [ ] **Step 7: Review implementation against every design requirement**

Read `docs/superpowers/specs/2026-08-15-native-orchestration-engine-design.md` and map every requirement to a passing test or an inspected implementation line. Record any gap instead of declaring completion.

- [ ] **Step 8: Commit the verified integration**

```powershell
git add tests/orchestration-e2e.test.mjs README.md herdr-plugin.toml VERSION
git commit -m "test: verify native orchestration engine end to end" -m "Exercise template compilation, frontend/backend fan-out and join, authenticated callbacks, Reviewer isolation, final Leader decisions, do/goal exclusion, restart recovery, plugin registration, and release metadata through temporary-repository integration tests."
```
