# Herdr Goal Wait Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增使用 Herdr wait 原语推进的 `$herdr-workflows:goal`，并保持 `$herdr-workflows:do` 的事件驱动行为不变。

**Architecture:** 新入口采用现有薄 Skill 模式，所有行为规则仍由核心 Skill 统一维护。运行时不新增第二套状态机；goal 由 Leader 同步等待，do 继续由事件桥推进。

**Tech Stack:** Markdown Skills、OpenAI Skill UI YAML、Node.js `node:test`。

## Global Constraints

- `mode=do` 只允许事件推进。
- `mode=goal` 只允许 `agent.prompt --wait` / `agent.wait` 推进。
- Reviewer 始终只读业务源码，Leader 保留最终裁决权。
- 不修改现有事件桥和工作流状态机行为。

---

### Task 1: Goal 入口和模式隔离

**Files:**
- Create: `skills/goal/SKILL.md`
- Create: `skills/goal/agents/openai.yaml`
- Create: `tests/goal-mode.test.mjs`
- Modify: `skills/herdr-workflows/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Herdr 官方 `agent.prompt --wait`、`agent.wait`、`agent.get`、`agent.read`。
- Produces: `$herdr-workflows:goal` 薄入口和核心 `mode=goal` 行为契约。

- [ ] **Step 1: 编写失败测试**

新增测试读取入口和核心 Skill，断言 goal 入口存在、固定 `mode=goal`、保留初始 do 完整闭环、使用等待原语、不调用 dispatch，并断言 do 仍由事件推进。

- [ ] **Step 2: 运行测试并确认因入口缺失而失败**

Run: `node --test tests/goal-mode.test.mjs`
Expected: FAIL，提示 `skills/goal/SKILL.md` 不存在。

- [ ] **Step 3: 添加最小 Skill 与文档实现**

创建 goal 薄入口及 UI 元数据，在核心 Skill 中增加 goal 的同步等待流程、超时诊断和模式隔离规则，并更新 README 入口表和使用说明。

- [ ] **Step 4: 运行目标测试和全量测试**

Run: `node --test tests/*.test.mjs`
Expected: PASS。

Run: `powershell -ExecutionPolicy Bypass -File tests/run-check-agents-tests.ps1`
Expected: PASS。

- [ ] **Step 5: 提交**

提交信息详细记录新增入口、调度隔离、文档和验证结果，便于周报统计。
