# Herdr 事件托管工作流设计

## 目标

`mode=do` 的流程推进由插件状态机拥有。Leader 只负责生成共享计划并触发一次 `dispatch`，调用返回后结束本轮；实施、审查和最终裁决之间只由 Herdr 官方状态事件推进。

## 数据与状态

- 共享计划固定写入项目 `.herdr/workflow-plan.md`。
- 每轮完整审核结论写入 `.herdr/reviews/<runId>.md`；审核者对业务源码只读，只拥有该文件的写权限。
- 当前状态写入 `.herdr/workflow-state.json`，使用原子替换保存。每次 dispatch 生成新的 `runId`。
- 状态依次为 `READY`、`IMPLEMENTATION_RUNNING`、`REVIEW_RUNNING`、`FINAL_DECISION_PENDING`；阻塞事件进入 `BLOCKED`。
- 每次 dispatch、阻塞和迁移都追加 `.herdr/workflow-events.jsonl`，作为恢复依据和可审计事件账本。
- 项目级锁串行化跨进程读改写；投递成功后才能提交状态迁移，投递失败保持原阶段以便重放。

## 入口与迁移

插件注册 `dispatch` Action。它从 Herdr 0.8 的 `workspace_cwd`、`focused_pane_cwd` 定位项目，通过官方 `agent.list`、`agent.prompt` 将共享计划路径发给实施者，不内联计划正文；下发成功后才把状态从 `READY` 推进到 `IMPLEMENTATION_RUNNING`，随后立即退出，不调用任何等待 API。

事件桥监听清单中的 `pane.agent_status_changed`，同时接受载荷中的 `pane.agent_status_changed` 与 `pane_agent_status_changed`。只有符合当前状态的事件能够迁移：实施者完成后用短消息通知审查者计划路径和本轮审核结果路径；审查者完成且审核文件非空后，只把结束状态和文件路径发给 Leader。审核文件缺失或为空时保持 `REVIEW_RUNNING` 并唤回审查者；乱序或重复事件不得推进。

## 幂等与恢复

有 revision 时使用 Herdr revision 形成事件键；无 revision 时使用 `runId`、工作区、pane、Agent、状态和当前工作流阶段形成稳定键。同一工作流实例同一阶段的完成事件只提交一次。目标 Agent 必须严格属于当前 workspace，禁止回退其他 workspace 的同名 Agent。进程重启后从状态文件和事件账本恢复。

`agent.prompt` 是推进流程的成功边界；`notification.show` 只用于诊断。系统选择至少一次投递：崩溃窗口允许重复提醒，但不得因提前推进状态而丢失流程。

## 测试与兼容性

测试使用 Herdr 0.8 的真实下划线载荷，并覆盖无 revision、重复事件、乱序事件和 dispatch 无等待退出。实现不修改 Herdr 官方源码，继续通过官方 Socket API 通信。
