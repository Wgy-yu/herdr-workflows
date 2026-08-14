# Herdr 事件托管工作流设计

## 目标

`mode=do` 的流程推进由插件状态机拥有。Leader 只负责生成共享计划并触发一次 `dispatch`，调用返回后结束本轮；实施、审查和最终裁决之间只由 Herdr 官方状态事件推进。

## 数据与状态

- 共享计划固定写入项目 `.herdr/workflow-plan.md`。
- 当前状态写入 `.herdr/workflow-state.json`，使用原子替换保存。
- 状态依次为 `READY`、`IMPLEMENTATION_RUNNING`、`REVIEW_RUNNING`、`FINAL_DECISION_PENDING`；阻塞事件进入 `BLOCKED`。
- 每次迁移同时追加 `.herdr/workflow-events.jsonl`，作为可审计事件账本。

## 入口与迁移

插件注册 `dispatch` Action。它读取项目配置和共享计划，通过 Herdr 官方 `agent.list`、`agent.prompt` 将计划发给实施者，将状态从 `READY` 推进到 `IMPLEMENTATION_RUNNING`，随后立即退出，不调用任何等待 API。

事件桥监听清单中的 `pane.agent_status_changed`，同时接受载荷中的 `pane.agent_status_changed` 与 `pane_agent_status_changed`。只有符合当前状态的事件能够迁移：实施者完成后唤醒审查者，审查者完成后唤醒 Leader；乱序或重复事件不得推进。

## 幂等与恢复

有 revision 时使用 Herdr revision 形成事件键；无 revision 时使用工作区、pane、Agent、状态和当前工作流阶段形成稳定键。同一阶段的同一完成事件只投递一次。进程重启后从状态文件和事件账本恢复。

## 测试与兼容性

测试使用 Herdr 0.8 的真实下划线载荷，并覆盖无 revision、重复事件、乱序事件和 dispatch 无等待退出。实现不修改 Herdr 官方源码，继续通过官方 Socket API 通信。
