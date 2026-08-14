---
name: herdr-workflows
description: 通过外置 Herdr Workflows 插件配置并运行可移植的多智能体工作流，覆盖本机 Agent 检查、首次初始化、两层配置管理、共享 Markdown 评审与开发实施闭环；六个薄 Skill（$herdr-workflows:init、$herdr-workflows:check、$herdr-workflows:config、$herdr-workflows:workflow、$herdr-workflows:review、$herdr-workflows:do）共享本事实源。
---

# herdr-workflows

通过 Herdr 检查、配置、审查和运行多 Agent 工作流。本 Skill 是唯一工作流事实源：
五个薄 Skill 只声明入口语义并指向本 Skill；角色解析、门禁、初始化、通信、审查、
返修和最终验收的规则只在这里维护，不得复制进入口 Skill。

## 入口与 mode

- `mode=check`：检查本机 Agent 与 Superpowers 状态。
- `mode=init`：首次安装后的 Agent、Superpowers、全局配置和项目工作流初始化。
- `mode=config`：配置本机 Agent 能力和默认分工。
- `mode=workflow`：配置项目工作流。
- `mode=review`：启动源码只读、评审单可追加的多 Agent 审查。
- `mode=do`：启动多 Agent 开发实施闭环。

用户随入口 Skill 提供的其余文本是当前 mode 的运行时参数（例如 `mode=workflow`
时的目标工作流名、`mode=config` 时的目标 Agent 标识），优先级高于配置文件和默认值。

## Herdr 环境门禁（所有 mode 共用）

- 需要控制 Herdr（窗格、标签页、Agent）时，必须先确认当前会话处于 Herdr 环境
  （`HERDR_ENV=1`）。不在 Herdr 环境中：停止控制操作，指导用户从 Herdr 管理窗格启动
  Leader，不伪造门禁通过。
- Herdr 能力以 `herdr --skill` 输出为事实源。窗格、消息、等待和 Agent 检测复用 Herdr
  已提供的能力，不自行实现，不凭记忆假设子命令与参数。

## 公共工作流初始化（mode=review / mode=do 共用）

1. 盘点：读取 Herdr 当前状态（窗格、标签页、Agent、工作目录）。
2. 补齐：只补齐缺失的窗格与 Agent。Agent 命令不存在时报告未安装，不创建窗格启动。
   适配器表（`references/agent-adapters.yaml`）记录每个 Agent 的启动方式；Windows 下
   为 `.ps1` shim 的 Agent 使用 `herdr pane run`，原生 EXE 使用 `herdr agent start`；
   不得在已知不兼容时强行使用另一种方式。
3. 通信冒烟：使用 `herdr --skill` 已发现的点对点消息能力验证 Leader 与每个 Agent，
   以及不同 Agent 之间的双向通信。每条链路使用唯一一次性字符串并逐字符核对；消息必须
   由发送 Agent 直接发给接收 Agent，Leader 不代为转述。不一致即视为该 Agent 或链路未就绪。
4. 通信规则：Agent 之间直接发送任务交接、评审单路径、轮次号和问题 ID；长篇结论与
   证据写入共享文档，消息中只发送定位信息。点对点能力不可用或冒烟失败时停止工作流，
   不回退为由 Codex/Leader 复制粘贴长文本。
5. 状态读取与异常处理：Agent 状态为 unknown、超时或阻塞时，先读取其状态和最近输出
   再决定下一步，不重复盲发提示。

## Agent 直连与命令调用

- Agent 间高层通信使用 Herdr 的 `agent.prompt`，可指定目标并等待回执；输出读取使用
  `agent.read`。这些调用由发送者直接发给目标 Agent，Leader 不代为转述。
- 如用户明确授权目标 Agent 在自己的终端执行命令，可使用 `agent.send_keys` 或
  `pane.send_text` 将命令输入目标窗格，再用 `agent.read`/`pane.read` 获取结果；先用
  `herdr --skill` 或 `herdr api schema --json` 确认当前参数，不猜测 CLI 参数。
- 这提供的是“让另一个 Agent 在其自身权限和工作目录中执行”，不是跨 Agent 提权或静默
  远程 Shell。命令、目标和等待范围必须由用户任务授权，涉及安装、删除、覆盖、外部服务
  或秘密时仍按权限门禁处理。

## Herdr 事件桥接（避免 Leader 轮询）

- 插件根目录的 `herdr-plugin.toml` 是官方 Herdr 外置插件清单；它只注册
  `pane.agent_status_changed` 事件，不修改官方 Herdr 代码。
- 用户确认注册该插件后，Herdr 在 Agent 状态变为 `done` 或 `blocked` 时启动
  `herdr-event-bridge.mjs`。桥接读取项目 `.herdr/workflows.yaml`，通过官方 Socket API
  的 `agent.list` 找到配置角色，再用 `agent.prompt` 直接通知目标 Agent：实施者完成后直达
  审查者，审查者完成后直达 Leader，任一角色阻塞时直达 Leader。
- 通知正文只包含状态、角色、pane/workspace 和共享事件记录路径；长篇证据仍写入评审单。
  事件会追加到 `<repo>/.herdr/workflow-events.jsonl`，带 Herdr 状态序号的重复事件不会重复
  通知。目标 Agent 暂时不可用时，桥接退回官方 `notification.show`，不会让 Leader 充当中继。
- 该桥接只处理已明确配置三类角色的项目；角色未配置、项目配置不存在或事件不是可路由状态时
  安全跳过并留下 Herdr 插件日志，不伪造完成结论。

## 配置模型（mode=config / mode=workflow 及所有 mode 共用）

两层配置 + 插件默认值，优先级从高到低：

1. 入口 Skill 运行时参数或用户在当前对话中的明确指令。
2. 项目覆盖：`<repo>/.herdr/workflows.yaml`。
3. 用户全局：`%USERPROFILE%/.config/herdr-workflows/config.yaml`。
4. 插件默认：`assets/defaults.yaml`。

- 全局配置保存本机相关内容（Agent 命令、启动参数、模型参数、最大权限参数、默认角色资格）。
- 项目配置只保存可共享内容（角色绑定、步骤顺序、门禁、返修次数、完成条件）；
  禁止秘密、用户目录绝对路径和只在单台机器成立的可执行文件路径。
- 配置统一使用 UTF-8 YAML，可包含中文 `#` 注释；强制规则必须用正式字段表达，
  不能只写在注释里。字段、合并与安全规则的完整定义见 `references/config-schema.md`。
- 配置读写必须使用 `scripts/config-tool.mjs`（结构化解析，随插件固定分发 YAML 解析器）：
  - 校验：`node scripts/config-tool.mjs validate --scope global|project --file <path>`
    （或 PowerShell 入口 `scripts/validate-config.ps1 -Scope global|project -Path <path>`）。
  - 合并：`node scripts/config-tool.mjs merge --defaults <path> [--global <path>] [--project <path>] [--workflow <name>]`。
  - 写回：`node scripts/config-tool.mjs update --file <path> --scope global|project --set '<json>'`
    （`--set` 为点分路径映射，如 `{"agents.claude.default_role":"reviewer"}`）。
  - 成功时只向 stdout 输出 JSON；错误时 stderr 输出 `CONFIG_INVALID <字段路径> <原因>` 并返回 1。
- 写配置必须使用 `update` 子命令：只更新明确字段路径、保留所有未知字段和不相关 Agent、
  临时文件生成并校验通过后原子替换，失败不部分写入。禁止手工字符串拼接或正则修改 YAML。

## mode=check：检查本机 Agent 与 Superpowers 状态

输入：无（入口运行时参数可选指定要检查的 Agent）。只读模式：本 mode 不修改配置、
不安装任何软件，除非用户逐项确认 Superpowers 安装。

1. 执行 Herdr 环境门禁（需要读取 Agent 支持列表时）。
2. 运行 `scripts/check-agents.ps1`：它从当前 `herdr agent start --help` 发现全部 Agent
   kind，对每个 kind 输出结构化 JSON（`kind`、`command`、`command_type`、`version`、
   `status`、`launch_method`、`adapter_status`、`elevated_args`、`elevated_verified`、
   `superpowers_status`）。脚本只运行 `Get-Command`、`--version`、`--help` 和目录
   存在性检查，不启动 Agent、不安装软件。
3. 解读状态：`available`（可用）、`available_with_warnings`（命令存在但版本探测为空或
   失败，启动前需人工确认；`diagnostics.version_probe`/`diagnostics.help_probe` 以
   ok|empty|failed|skipped 机器判定，不使用 launch_error——check 不启动 Agent）、
   `not_installed`（未安装）、`unsupported_adapter`（Herdr 支持但插件尚无适配器）；
   最大权限参数 `elevated_verified=false` 表示帮助未包含适配器参数，不得猜测参数启动。
4. Superpowers 缺失时（`superpowers_status=absent`），只读展示该 Agent 的官方来源、
   目标目录和完整安装说明（来自 `references/agent-adapters.yaml` 的 `superpowers` 字段）。
   `mode=check` 不执行安装；首次安装请使用 `mode=init`，由 init 逐个询问并在存在已验证
   `superpowers.install` 且用户确认后执行，安装后重新检查目标目录和可发现状态。
5. 禁止：静默批量安装、覆盖已存在目录、从非官方来源安装、因目录名称相同就宣称安装成功。
6. 终止条件：输出状态表和每个未就绪项的处理建议；Superpowers 被用户拒绝时，
   依赖 Superpowers 的工作流不得假装通过门禁，明确记录缺口。

## mode=init：首次安装初始化

输入：可指定项目路径、工作流名、`leader`、`implementer`、`reviewer` 或是否立即启动
工作流。初始化是配置向导，不把当前 Codex 会话隐式当作 Leader，也不静默安装软件。
init 按“本机 Agent 配置（mode=config）→ 项目工作流配置（mode=workflow）”顺序执行，
共享同一套结构化配置工具和安全门禁，不通过终端复制粘贴伪造两个 mode 的结果。

1. 解析项目根目录并运行 `mode=check` 的只读检查。若只做本机检查，不要求 Herdr 窗格；
   进入 Agent 启动、消息或安装操作前必须通过 `HERDR_ENV=1` 门禁。
2. 汇总 `available`/`available_with_warnings` Agent，展示 kind、命令、启动方式、最大权限
   参数验证状态和 Superpowers 状态。`not_installed`、`unsupported_adapter` 或未验证最大
   权限参数的 Agent 不能被静默纳入角色。
3. 让用户明确选择 Leader、实施者和审核者。没有明确选择时保持 `null` 并停止进入工作流；
   不按当前客户端、Agent 排序或插件默认值推断 Leader。允许同一 Agent 承担多个角色，但
   必须把该决定写入项目配置并在摘要中提示。
4. 对用户选中的每个 Agent 处理 Superpowers：按适配器启动并确认目标 Agent 已就绪；已存在则记录；缺失且适配器有非空、已验证的
   `install` 时，逐个展示来源与命令，取得该 Agent 的单独确认后，通过 `agent.prompt` 直接
   发送安装指令并等待回执，再重新检查；`install: null` 时只展示官方说明并标记为待用户手动
   完成，禁止自行拼接安装命令或宣称已安装。
5. 使用 `scripts/config-tool.mjs update` 写入全局 Agent 配置（只写明确字段、保留未知字段）
   并校验；不得把 API Key、Token、密码或其他秘密写入配置。
6. 使用同一个结构化 `update` 工具创建或更新项目 `<repo>/.herdr/workflows.yaml`：设置
   `default_workflow`、所选工作流的 `leader`/`implementer`/`reviewer`、审查只读约束、返修
   次数、通过条件和可选 `role_rotation`；不得手工拼接 YAML。已有项目绑定保留，只有用户确认的字段才覆盖。
7. 运行项目校验与 `config-tool.mjs merge`，输出全局配置、项目工作流、角色映射、Superpowers
   状态及待办。只有三类角色已明确绑定、配置校验通过且安装门禁满足时才输出 `INIT_READY`；
   否则输出 `INIT_INCOMPLETE` 和阻塞项。除非用户明确指定立即运行，否则初始化到此结束。
8. 若运行在 Herdr 环境且用户确认，检查并注册外置事件桥接：优先使用
   `herdr plugin install Wgy-yu/herdr-workflows --yes`，本地开发使用
   `herdr plugin link <插件根目录>`；注册后用 `herdr plugin list --plugin wgy.herdr-workflows-bridge`
   确认无 manifest warning。用户拒绝或 Herdr 版本低于 `0.7.0` 时，不阻塞配置初始化，但必须
   输出“事件直达未启用”，并说明 Leader 仍需按普通点对点通信推进。

## mode=config：配置本机 Agent 能力和默认分工

输入：入口运行时参数可指定目标 Agent 标识。写入授权：只写用户全局配置
`%USERPROFILE%/.config/herdr-workflows/config.yaml`，不写项目文件。

1. 先运行 `scripts/check-agents.ps1` 做只读检查。
2. 展示目标 Agent 的现有配置（若有）与拟变更摘要，用户确认后才写入。
   写入必须使用结构化 update，精确调用：
   `node scripts/config-tool.mjs update --file "%USERPROFILE%/.config/herdr-workflows/config.yaml" --scope global --set '{"agents.<id>.<字段>":"<值>"}'`
3. 写入后运行 `--scope global` 校验和一次不读写项目文件的通信冒烟。
4. 每个 Agent 可配置：`kind` 与命令、原生启动参数、最大权限参数是否启用、模型及
   模型参数、默认角色资格、Superpowers 状态。
5. 终止条件：校验通过且通信冒烟成功；校验失败时不写入并报告字段路径。

## mode=workflow：配置项目工作流

输入：入口运行时参数可指定工作流名或要修改的字段。写入授权：只写项目覆盖配置
`<repo>/.herdr/workflows.yaml`，不写用户全局配置。

1. 项目可定义多个命名工作流和一个默认工作流；每个工作流至少包含：Leader、实施者、
   审核者角色绑定；设计、计划、实施、审查、返修和最终验收的步骤顺序；各步骤是否
   启用及所需 Skill；Reviewer 源码只读约束；最大返修次数与超限接管者；通过和拒绝的输出条件。
   可选开启 `role_rotation`，允许实施者与审查者在阶段边界轮换；默认关闭。
2. 写入必须使用结构化 update，精确调用：
   `node scripts/config-tool.mjs update --file "<repo>/.herdr/workflows.yaml" --scope project --set '{"workflows.<name>.<字段>":"<值>"}'`；
   写入后运行 `--scope project` 校验和合并命令确认有效配置。
3. 用户明确指定的角色覆盖当前工作流，但不得关闭插件硬安全边界（Reviewer 不修改业务
   源码、最大权限不扩大授权、Leader 最终裁决）。Leader 可以是任一已验证可用 Agent，
   不得因为当前调用方是 Codex 就自动绑定 `codex`。
4. 终止条件：项目校验通过；配置含秘密或绝对路径时拒绝并指出路径。

## mode=review：共享 Markdown 评审

输入：入口运行时参数可指定工作流名、角色覆盖或评审单路径。授权：所有 Agent 对业务
源码只读；唯一允许创建和修改的项目文件是本轮共享 Markdown 评审单。不得格式化、暂存、
提交或修改其他文件，不得运行会产生其他工作树写入的命令。

1. 解析工作流（`config-tool.mjs merge`）并验证所有角色有可用 Agent。
2. 执行公共工作流初始化（盘点、补齐、点对点双向通信冒烟）。
3. 记录审查前 Git 状态和 diff 摘要（HEAD、分支、工作树变更清单）。
4. Leader 基于 `assets/review-sheet-template.md` 创建唯一评审单。默认路径为
   `<repo>/.herdr/reviews/<YYYYMMDD-HHmmss>-<安全化分支名>.md`；用户可指定仓库内的
   `.md` 相对路径。路径必须位于仓库内、不得覆盖现有文件，创建后将相对路径点对点发送
   给参与 Agent。
5. 评审单是唯一持久事实源。每轮只允许当前接棒 Agent 写入：写前重读全文，仅在文件末尾
   追加一个完整轮次，不删除、替换或重排既有内容；纠错也通过新轮次追加。轮次必须包含
   作者、角色、时间、`结论`、`证据`、对既有问题的`确认/驳回`，并使用稳定问题 ID。
6. 第一审查者追加按严重度排序的问题及文件/行号证据，然后直接向下一 Agent 发送
   `评审单路径 + 轮次号 + 问题 ID` 完成交接；不得让 Leader 转发正文。
7. 后续审查者直接读取同一评审单，逐项确认、驳回或补充并追加新轮次；需要澄清时可与
   对方点对点通信，达成的实质结论必须追加回评审单，终端输出不作为最终依据。
8. Leader 在各 Agent 完成交接后独立抽查，仅追加`最终裁决`轮次，不改写前述意见。
   最终轮次必须给出 `REVIEW_CHANGES_REQUIRED`（含有效问题 ID）或 `REVIEW_PASS`。
9. 比较审查前后 Git 状态：只允许新增或追加本轮评审单；任何其他工作树修改都判定流程
   失败并报告，保留现场，不自动回滚。评审单本身保留给用户，不自动暂存或提交。
10. Reviewer 可以最大权限启动以避免文件读取弹窗，但提示中只能授权读取源码和追加本轮
    评审单；最大权限是技术启动能力，不是修改源码或其他文件的业务授权。
11. 终止条件：评审单含完整轮次与 Leader 最终裁决；面向用户只返回裁决摘要和评审单路径，
    不在终端重复整份长文本。点对点通信失败或出现评审单之外的写入时报告流程失败。

## mode=do：多 Agent 开发实施闭环

输入：入口运行时参数可指定工作流名或角色覆盖。写入授权：只有实施者修改代码，
范围限定在任务目标内；审核者始终只读；只有 Leader 可宣布最终通过。

1. 解析工作流并完成与 mode=review 相同的 Herdr 初始化和通信验收。
2. 按工作流执行设计与用户确认门禁（用户未确认不得进入实施）。
3. 生成可执行计划并完成实施者的计划读取回执（逐字符核对）。
4. 实施者修改代码并提供 diff 与验证证据。
5. 审核者只读复核；Leader 使用 `superpowers:receiving-code-review` 验证审查意见，
   不盲从审核结论。
6. 已确认问题返回实施者返修；达到工作流 `max_rework` 上限后由 `takeover_on_exceed`
   指定的接管者处理，不再自动返修。
7. 审核者通过后，Leader 独立运行项目检查并作最终裁决。
8. 实施者与审核者可通过 Herdr 点对点消息直接澄清证据、交接复核和反馈返修，不由 Leader
   转发正文；双方不得自行宣布流程结束，实质结论必须对 Leader 可审计，且不得取消 Leader
   最终裁决。用户可动态指定 Agent 分工。
9. 事件桥接已注册时，Leader 不主动轮询实施者或审查者；以 Herdr 状态事件和共享事件记录为
   触发事实。若事件桥接未启用，才按当前 Herdr 能力使用 `agent.wait`，不得用长时间终端轮询
   模拟等待。桥接通知只负责唤醒下一角色，不替代 Leader 的最终裁决。
10. 当 `workflow.roleRotation.enabled=true` 时，Leader 可依据当前 Skill、上下文负载和
   `intervalMinutes` 在阶段边界决定是否轮换实施者与审查者；不在 Agent 回合中途切换。
   轮换前检查全局 Agent 的 `capabilityTier`。任一缺失、差距大于 1，或模型能力无法可靠比较时，
   先向用户提示“两个 Agent 的模型能力不要差距过大”，得到确认后再切换；未确认则保持原角色。
   `maxSwitches` 用于限制本轮轮换次数。轮换不改变 Reviewer 只读门禁。
11. 终止条件：Leader 宣布最终通过（或明确否决）；返修达上限且接管完成。

## 权限和安全边界

最大权限启动参数（`elevated_args`）只消除普通本地权限提示。以下操作不能因最大权限
模式而自动授权，必须由 Leader 根据用户请求和项目规则决定，缺少授权时询问用户：

- 删除、覆盖或移动用户未明确纳入范围的文件。
- 新增或升级依赖。
- 写入仓库外、生产系统或第三方服务。
- 提交、推送、创建 PR 或发布。
- 读取、保存或转发秘密。
- 扩大任务目标或项目范围。

插件不保存或读取任何 API Key、访问令牌或数据库口令。

## 错误处理

- 不在 Herdr 环境：停止控制操作，指导用户从 Herdr 管理窗格启动 Leader。
- Agent 命令不存在：报告未安装，不创建窗格启动。
- Agent 为 Windows `.ps1` shim：按当前 Herdr 能力选择 `herdr pane run`；
  不得在已知不兼容时使用 `herdr agent start`。
- 最大权限参数验证失败：回退为未适配状态，不用猜测的参数启动。
- Superpowers 缺失：询问安装；用户拒绝后，依赖 Superpowers 的工作流不得假装通过门禁。
- init 自动安装：仅执行适配器中已验证且非空的 `superpowers.install`，其余 Agent 只提供官方手动说明。
- Agent 状态为 unknown、超时或阻塞：读取状态和最近输出后处理，不重复盲发提示。
- review 模式出现评审单以外的工作树修改：保留现场并报告，不自动回滚用户或 Agent 变更。
- Agent 点对点通信不可用或双向冒烟失败：停止工作流，不让 Leader 充当人工消息中继。
- 角色轮换开启但能力等级缺失、差距大于 1 或用户未确认：保持原角色并报告未轮换原因。
- 配置无效：指出字段路径和原因，不部分写入配置。

## 适配器与新增 Agent

新增 Agent 适配器时：先在目标机器安装该 Agent，用其 `--help` 验证最大权限参数和
模型参数格式，再写入 `references/agent-adapters.yaml`；未经验证的字段一律不填
（Superpowers 安装命令不可验证时为 `null`）。不得为未知 Agent 猜测参数或安装操作。
