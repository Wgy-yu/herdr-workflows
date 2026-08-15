# Herdr Goal 等待工作流设计

## 目标

为开发实施闭环提供两个互斥入口：`mode=do` 继续由 Herdr 官方状态事件推进，`mode=goal` 使用 Herdr 官方等待原语在当前 Agent Goal 内推进。Goal 模式不依赖事件桥，避免事件唤醒与 Goal 暂停/续跑机制冲突。

## 入口与职责

- `$herdr-workflows:do` 固定使用 `mode=do`，保持现有事件驱动行为。
- `$herdr-workflows:goal` 固定使用 `mode=goal`，复用设计、计划、实施、只读审核、返修和 Leader 最终裁决门禁。
- 薄入口只声明 mode；共享规则继续集中在 `skills/herdr-workflows/SKILL.md`。

## 调度语义

`do` 写入共享计划后调用插件 `dispatch` Action，结束当前动作，后续只由 `pane.agent_status_changed` 事件推进。

`goal` 由 Leader 使用 `agent.prompt ... --wait --timeout <毫秒>` 下发当前阶段；超时后先用 `agent.get` 和 `agent.read` 判断状态，再对仍在运行的同一任务调用 `agent.wait`，不得重复下发。实施完成后同步进入只读审核，审核完成后由 Leader 验证结论、组织返修或最终验收。Goal 模式不调用 `dispatch` Action，不读取或迁移 `.herdr/workflow-state.json`，也不等待事件桥唤醒。

## 兼容性与验证

- `event_bridge_required` 仍是 `do` 的硬门禁，不约束 `goal`。
- 现有事件桥、状态机和 Action 实现保持不变。
- 测试验证 goal 入口存在、入口 mode 固定、共享 Skill 明确 wait 语义与模式隔离，并继续运行全部现有 Node 与 PowerShell 测试。
