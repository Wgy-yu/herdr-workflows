# Event-Owned Herdr Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Herdr plugin own do-workflow transitions so the Leader dispatches once and exits while official events wake later roles.

**Architecture:** A workflow-state module serializes project mutations with a lock, records dispatch and transition outcomes in a ledger, and persists a state snapshot. The Action and event bridge use Herdr 0.8 context fields, strictly scope Agent targets to the active workspace, and advance only after `agent.prompt` succeeds.

**Tech Stack:** Node.js ESM, `node:test`, Herdr plugin manifest and Socket API.

## Global Constraints

- Do not modify official Herdr code.
- Do not call `agent.wait` or use the `wait` option of `agent.prompt`.
- Persist project workflow state beneath `.herdr`.
- Never fall back to an Agent in another workspace.
- Failed delivery must leave the current workflow stage retryable.

---

### Task 1: Real event compatibility and idempotency

**Files:**
- Modify: `tests/herdr-event-bridge.test.mjs`
- Modify: `herdr-event-bridge.mjs`

- [ ] Add failing tests using `type: pane_agent_status_changed` and no revision.
- [ ] Verify they fail with `unsupported-event` or duplicate delivery.
- [ ] Normalize supported payload names and derive a stage-aware fallback key.
- [ ] Run the bridge test file and verify it passes.

### Task 2: Persisted workflow state and dispatch Action

**Files:**
- Create: `workflow-state.mjs`
- Create: `herdr-workflow-dispatch.mjs`
- Create: `tests/herdr-workflow-dispatch.test.mjs`
- Modify: `herdr-plugin.toml`

- [ ] Add failing tests for legal transitions, rejected out-of-order transitions, and one-shot dispatch.
- [ ] Verify the tests fail because the module and Action do not exist.
- [ ] Implement atomic state persistence and a dispatch Action that calls only `agent.list` and `agent.prompt`.
- [ ] Register the Action and verify its tests pass.

### Task 3: Event bridge state ownership

**Files:**
- Modify: `herdr-event-bridge.mjs`
- Modify: `tests/herdr-event-bridge.test.mjs`

- [ ] Add failing tests proving events cannot route from the wrong workflow stage.
- [ ] Verify the failure reflects missing state enforcement.
- [ ] Gate routing through persisted state transitions and record the resulting stage.
- [ ] Run all plugin tests.

### Task 4: User and Agent documentation

**Files:**
- Modify: `README.md`
- Modify: `skills/herdr-workflows/SKILL.md`

- [ ] Document `.herdr/workflow-plan.md`, the dispatch Action, states, diagnostics, and immediate Leader exit.
- [ ] Update Skill instructions so the standard do path invokes the Action instead of direct prompt/wait logic.
- [ ] Run the full plugin test suite and repository checks.

### Task 5: Review remediation

**Files:**
- Modify: `workflow-state.mjs`
- Modify: `herdr-workflow-dispatch.mjs`
- Modify: `herdr-event-bridge.mjs`
- Modify: `tests/workflow-state.test.mjs`
- Modify: `tests/herdr-workflow-dispatch.test.mjs`
- Modify: `tests/herdr-event-bridge.test.mjs`

- [ ] Add failing tests for Herdr 0.8 cwd fields and strict workspace matching.
- [ ] Add failing tests proving failed notifications do not advance state and can be replayed.
- [ ] Add failing tests for concurrent transitions, dispatch/BLOCKED ledger entries, and a new `runId` per workflow.
- [ ] Implement project locking, delivery-before-commit ordering, and run-scoped fallback keys.
- [ ] Run all Node, PowerShell, structure, and syntax checks.
