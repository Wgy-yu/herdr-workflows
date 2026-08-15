# Herdr 原生事件驱动编排引擎设计

## 目标

将现有 `herdr-workflows` 从固定开发闭环升级为 Herdr 原生事件驱动编排引擎。引擎支持内置模板、受约束的自建工作流、前后端并行实施、结构化 Agent 回调、可恢复状态和完整审计，同时保留 `do` 与 `goal` 两个入口。

每个仓库同一时间只允许一个活动工作流。新引擎直接使用新持久化目录，不读取或迁移旧的 `.herdr/workflow-state.json`、`.herdr/workflow-plan.md` 和 `.herdr/workflow-events.jsonl`。

## 已确认的产品边界

- 运行方式：Herdr 原生插件 Action 与状态事件驱动，不增加常驻 daemon。
- 并发模型：每个仓库只允许一个活动工作流；一个工作流内部允许并行阶段。
- 入口模型：`do` 与 `goal` 共用同一状态机、契约、产物和安全门禁，二者不能同时运行。
- 模板模型：提供内置模板，也允许用户创建工作流；模板实例可替换 Agent、模型参数、路径范围、测试和返修上限。
- 安全模型：Reviewer 业务源码只读、结构化完成回调、修改范围检查、返修上限和 Leader/人工最终裁决均不可关闭。
- 前后端模板：前端和后端并行实施，全部有效报告汇合后进入统一集成审查。
- 兼容策略：直接切换新持久化目录，不提供旧状态迁移或双读。

## 架构

### Workflow Definition

读取内置模板或项目 YAML，将角色、阶段、依赖、修改范围、必跑测试、成功出口和失败出口编译为受约束状态图。编译结果写入不可变 `contract.json`，运行时不重新解释可变 YAML。

### Workflow Engine

纯 reducer 接收当前状态和结构化事件，返回新状态、持久化事件和待投递命令。该模块不调用 Herdr、不读取终端、不直接写文件。生命周期信号只提供运行证据，不能单独证明业务阶段完成。

### Workflow Store

负责仓库级单活动锁、追加事件日志、原子状态投影和报告验证。所有改写文件使用同目录临时文件加原子替换；每个事件包含单调序号和稳定幂等键。

### Herdr Adapter

插件 Action 和 `pane.agent_status_changed` 事件钩子负责查找 Agent、验证 workspace、发送短消息、观察生命周期并把信号转换为引擎事件。Adapter 不自行决定阶段是否完成。

### Agent Capability Adapter

每个 Agent 记录以下能力：

- `goal`：是否支持持续 Goal。
- `structured_callback`：是否能够调用或写入受验证的结构化回调。
- `read_only_tools`：是否能以工具白名单强制只读。

Codex Goal 是可选阶段执行能力，不是工作流事实源。Goal 可用时用于阶段内持续执行；不可用时使用普通 Herdr Agent 回合。两者均必须提交相同的磁盘结构化回调才能推进。

## 模板与自建工作流

### 内置模板

1. `development`：设计、计划、实施、审查、返修、验证、最终裁决。
2. `frontend-backend`：设计和接口契约确认后，前端、后端并行实施；汇合后执行集成审查、返修、验证和最终裁决。
3. `review-only`：一个或多个 Reviewer 只读审查，Leader 汇总并裁决，不允许修改业务源码。

### 定义示例

```yaml
template: frontend-backend

roles:
  leader:
    agent: codex-leader
  frontend:
    agent: codex-frontend
    writable_paths: ["frontend/**"]
  backend:
    agent: opencode-backend
    writable_paths: ["backend/**", "api/**"]
  reviewer:
    agent: claude-reviewer
    read_only: true

phases:
  - id: design
    role: leader
    callback: DESIGN_APPROVED

  - id: frontend_implement
    role: frontend
    needs: [design]
    callback: IMPLEMENTATION_READY
    required_tests: ["npm test"]

  - id: backend_implement
    role: backend
    needs: [design]
    callback: IMPLEMENTATION_READY
    required_tests: ["cargo test"]

  - id: integration_review
    role: reviewer
    needs: [frontend_implement, backend_implement]
    callback: REVIEW_RESULT

  - id: decision
    role: leader
    needs: [integration_review]
    callback: FINAL_DECISION
```

### 编译期强制规则

- 必须存在唯一的 Leader 最终裁决阶段。
- 所有实施阶段必须声明非空可写路径和必跑测试。
- Reviewer 必须为业务源码只读；能够使用工具白名单的 Agent 必须启用该能力。
- 每个可执行阶段必须声明结构化完成回调。
- 依赖图必须无环；返修只能使用引擎提供的有上限循环。
- 并行分支必须有明确 join 节点，且并行实施角色的可写路径不能重叠。
- 自动连续阶段推进最多 8 次，超过后进入 `BLOCKED` 并通知 Leader。
- YAML 阶段不能直接执行任意 shell；测试命令只作为阶段契约交给已授权实施 Agent，最终由 Leader 独立验证。
- 自建工作流不能关闭结构化回调、修改范围检查、Reviewer 只读、返修上限或最终裁决。

## 状态模型

### 工作流状态

```text
CREATED
→ RUNNING
→ WAITING_FOR_JOIN
→ REVIEWING
→ REWORKING
→ VERIFYING
→ DECISION_PENDING
→ COMPLETED | REJECTED | BLOCKED
```

### 阶段状态

```text
PENDING → DISPATCHED → WORKING
→ READY_FOR_REVIEW | BLOCKED
→ APPROVED | CHANGES_REQUESTED
→ SUPERSEDED
```

并行 fan-out 会同时激活所有依赖满足的阶段。join 只有在全部前置阶段提交合法回调、产物存在并通过范围检查后才能激活。任一分支 `BLOCKED` 时工作流进入 `BLOCKED`，Leader 明确恢复后才继续。

## 消息与结构化回调协议

每次派发和回调必须携带：

```text
workflow_id
run_id
phase_id
event_id
attempt
role
in_reply_to
contract_path
report_path
callback_token
```

允许的核心回调：

```text
TURN_STARTED
DESIGN_APPROVED
PLAN_READY
IMPLEMENTATION_READY
REVIEW_RESULT
CHANGES_REQUESTED
VERIFICATION_RESULT
FINAL_DECISION
BLOCKED
```

回调必须匹配当前工作流、run、阶段、attempt、角色、前置事件和一次性 token。重复、乱序、旧 run、错误角色或错误 token 的回调只写入拒绝审计记录，不推进状态。

报告采用 JSON 元数据与 Markdown 正文组合，先写权限受限的临时文件，再原子重命名。每个 attempt 只能成功提交一次最终报告；纠正必须创建新 attempt，不能覆盖已接受报告。

## Herdr 生命周期语义

- 派发前读取目标 Agent 状态，拒绝把已有 `working` 回合作为新阶段启动证据。
- 派发使用有界 `agent.prompt --wait --until working --timeout <剩余毫秒>`。
- prompt、后续状态检查和等待共用一个绝对截止时间，不创建无超时的 `agent.wait`。
- 未观察到新 `working`、`agent_prompt_stalled`、超时或响应丢失均记录为 `DELIVERY_UNKNOWN`；检查 Agent 和事件状态后由 Leader明确恢复，禁止自动重发。
- `idle`、`done` 只触发回调与产物检查；没有合法回调时阶段保持原状并通知对应 Agent 或 Leader。
- `unknown` 永远不代表成功。
- 长历史读取在 Agent 非 idle 时失败，不得据此判定阶段失败；完整答复必须写入阶段报告文件。

## do 与 goal

`do` 由 Herdr 生命周期事件唤醒 Adapter 并推进状态。`goal` 使用相同契约，在支持 Goal 的 Leader/Agent 中维持阶段内持续执行；Goal 不可用或 Goal 工具缺失时可以恢复为普通回合。

无论入口为何，业务推进均依赖结构化回调和磁盘产物。Codex `get_goal`/`update_goal` 只管理 Codex 自身 Goal 生命周期，不可直接写入工作流状态。活动入口和执行适配器写入 `contract.json`，另一个入口检测到活动锁时必须拒绝启动。

## 持久化与恢复

```text
.herdr/workflow/
├── definition.yaml
├── contract.json
├── state.json
├── events.jsonl
├── lock/
├── phases/<phase-id>.json
└── reports/<run-id>-<phase-id>-<role>-<attempt>.md
```

- `definition.yaml`：启动时解析的工作流定义快照。
- `contract.json`：编译后的不可变运行契约。
- `events.jsonl`：追加式事实记录。
- `state.json`：reducer 状态投影。
- `phases/`：各阶段的当前投影和关联事件。
- `reports/`：不可覆盖的阶段报告。

恢复时先验证锁所有者是否仍存活，再读取 contract，重放 events 并与 state 投影核对。投影不一致时停止自动推进，写入诊断并要求显式 repair；不得猜测或跳过事件。单次操作的提交顺序为：报告/阶段产物、事件、`state.json`。状态提交后，后续非关键投影失败可由 repair 重建。

## 安全边界

- Reviewer 对业务源码只读；若 Agent 支持工具白名单，必须移除 shell、edit、write 等能力，只保留读取和扩展自有报告工具。
- 实施 Agent 只能修改阶段契约列出的路径。进入审查前比较 Git baseline，越界修改立即阻塞。
- 报告工具只允许写入当前 workflow 的 `reports/`，验证真实路径仍位于该目录，使用一次性 token 和最大长度限制。
- Agent 不得修改 `contract.json`、`state.json`、`events.jsonl`、锁和其他角色报告。
- 新增依赖、删除文件、外部服务、提交、推送、发布和生产操作仍需用户授权。
- 最终完成和发布必须由 Leader 独立验证并经过人工裁决，模板或自建工作流均不能关闭。

## 错误处理

- 定义非法：编译失败，不创建活动工作流。
- Agent 不可用：阶段保持 `PENDING` 或 `DISPATCHED`，通知 Leader，不选择其他 workspace 的同名 Agent。
- 派发结果未知：记录 `DELIVERY_UNKNOWN`，不自动重发。
- 生命周期完成但缺少回调：保持阶段状态，发送只含契约和报告路径的短消息。
- 报告无效或越权：拒绝事件并进入 `BLOCKED`。
- 并行分支部分失败：保留已完成分支产物，阻塞 join；恢复时只重派未完成的新 attempt。
- 返修达到上限：停止自动循环，交由配置的接管者和 Leader 裁决。
- 自动阶段跳转超过 8 次：进入 `BLOCKED`，防止模板产生无限自动循环。
- 状态投影不一致：停止推进，要求显式 repair。

## 测试策略

### 定义与模板

- 三个内置模板均能编译。
- 模板替换 Agent 后拓扑和安全门禁保持不变。
- 自建工作流的环、缺失 join、重叠写路径、缺失测试、可写 Reviewer、缺失最终裁决均被拒绝。

### Reducer

- 开发模板完整成功、返修和拒绝路径。
- 前后端 fan-out、部分完成、全部 join、单分支阻塞和恢复。
- review-only 多报告汇合。
- 重复、乱序、旧 run、错误 attempt、错误角色和错误 token 回调。
- 自动跳转第 8 次允许、第 9 次阻塞。

### 持久化

- 原子报告和状态写入。
- 并发重复事件只提交一次。
- 死锁接管、部分提交恢复、事件重放和状态投影 repair。
- 路径穿越与 symlink 逃逸拒绝。

### Herdr Adapter

- 新回合 `working` 启动证明。
- 目标已在旧 `working` 回合时拒绝误判。
- stalled、timeout、unknown、blocked 和 Agent 不可用。
- do/goal 共用契约且活动锁互斥。
- 生命周期 `idle/done` 不会在缺少结构化回调时推进。

### 安全与端到端

- Reviewer 工具白名单不包含写业务源码能力。
- Git baseline 范围检查、必跑测试报告和 Leader 独立验证。
- 前后端模板在真实临时仓库中并行汇合。
- 插件 Action、事件钩子、manifest 和安装包验证。

## 源码对照与借鉴边界

开发对照仓库保存在独立临时目录 `C:/Users/wgy/AppData/Local/Temp/herdr-reference-plugins-20260815`：

- `herdr-orchestrator`：统一 deadline、新回合 working 证据、文件事件与锁事务。
- `herdr-board`：纯状态转换、成功/失败出口、自动跳转上限和恢复测试。
- `pi-herdr-squad`：只读工具白名单、一次性 token、结构化报告和原子写入。
- `herdr-factory-loop-skill`：Goal 能力矩阵和“磁盘状态而非 idle 决定完成”。

实现前必须核对各项目许可证。只借鉴公开协议和架构思想，不复制许可证不兼容或来源不明的代码。我们的实现继续使用仓库现有 Node.js、Markdown Skill、YAML 配置和 Herdr 原生插件机制，不引入 Rust daemon、SQLite 或通用脚本执行器。
