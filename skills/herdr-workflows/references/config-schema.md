# 配置模式与解析器来源

## 固定分发的 YAML 解析器

配置解析只使用插件内固定分发的 `vendor/js-yaml.mjs`（js-yaml 4.2.0，MIT），
不得使用正则或字符串拼接解析 YAML，不得依赖宿主项目依赖。

| 项目 | 值 |
| --- | --- |
| 包与版本 | `js-yaml` `4.2.0`（MIT） |
| npm 元数据 | https://registry.npmjs.org/js-yaml/4.2.0 |
| 官方仓库标签 | https://github.com/nodeca/js-yaml tag `4.2.0`（commit `590dbabadd172b099c07654fab2eabec8c7a07b9`） |
| 发行文件来源 | https://unpkg.com/js-yaml@4.2.0/dist/js-yaml.mjs |
| 许可证来源 | https://raw.githubusercontent.com/nodeca/js-yaml/4.2.0/LICENSE |
| npm tarball | https://registry.npmjs.org/js-yaml/-/js-yaml-4.2.0.tgz（SHA-512 integrity `ePWsvanv0DWuDRsW8dnt+R4jQ31SCRCQ7hhNcPXZPsoBZiemuZNYGf7adZdqX2D86j6rvKp3RpCxVTSb8WQlOw==`） |
| `vendor/js-yaml.mjs` SHA-256 | `5b4536e72a2203aa6f159630caeefde35a95d8f95620f5a1d3c48efe3a0e76fa` |
| `vendor/js-yaml-LICENSE` SHA-256 | `a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550` |

校验方法：从官方仓库确认 4.2.0 标签与 MIT 许可证；从 npm registry 核对版本、许可证与
tarball 完整性摘要；下载 tarball 后校验 SHA-512 与 registry 一致，并比对 tarball 内
`dist/js-yaml.mjs`、`LICENSE` 与 vendored 文件 SHA-256 完全一致。

## 两层配置

```text
全局配置：%USERPROFILE%/.config/herdr-workflows/config.yaml（本机相关内容）
项目覆盖：<repo>/.herdr/workflows.yaml（可共享内容）
插件默认：skills/herdr-workflows/assets/defaults.yaml（逻辑默认值）
```

优先级从高到低：本轮命令参数/对话指令 > 项目 `.herdr/workflows.yaml` >
用户全局 `config.yaml` > 插件 `assets/defaults.yaml`。

配置文件统一使用 UTF-8 YAML，可包含中文 `#` 注释；注释不参与解析。
强制规则必须使用正式字段表达，不能只写在注释中。

## 全局配置模式（scope=global）

顶层只允许 `agents`，每个 Agent 允许以下字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `kind` | string\|null | Herdr Agent 类型，如 `claude`、`opencode`、`codex` |
| `command` | string\|null | 本机命令；`null` 表示未配置 |
| `elevated_args` | string[] | 最大权限启动参数，如 `--dangerously-skip-permissions` |
| `elevated_enabled` | boolean | 是否启用最大权限参数（默认 true） |
| `model` | string\|null | 固定模型或 `null` 跟随默认 |
| `model_args` | string[] | 模型参数 |
| `default_role` | string\|null | 默认角色资格回退：`leader`/`implementer`/`reviewer`/`null` |
| `superpowers` | string\|null | `present`/`absent`/`unknown` |

全局配置允许本机绝对路径（它是本机专属文件），但仍禁止敏感字段。

## 项目配置模式（scope=project）

顶层只允许 `default_workflow`（string）与 `workflows`（对象）。
每个命名工作流允许以下字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `leader` | string\|null | 主持与最终裁决 Agent 标识；默认值为 null，必须由 init 或运行时参数明确选择 |
| `implementer` | string\|null | 实施 Agent 标识；默认值为 null，必须由 init 或运行时参数明确选择 |
| `reviewer` | string\|null | 审核 Agent 标识；默认值为 null，必须由 init 或运行时参数明确选择 |
| `reviewer_read_only` | boolean | Reviewer 对业务源码的只读约束（默认 true）；不禁止 review 模式追加本轮共享 Markdown 评审单 |
| `use_superpowers` | boolean | 是否在该工作流执行 Superpowers Skill 与安装门禁（默认 `true`） |
| `steps` | object | 各步骤 `{enabled: boolean, skill?: string}` |
| `max_rework` | 非负整数 | 最大返修次数（默认 5） |
| `takeover_on_exceed` | string | 超限接管者（默认 `leader`） |
| `role_rotation` | object | 是否允许实施者与审查者在阶段边界轮换 |
| `role_rotation.enabled` | boolean | 默认 `false`；开启后仍由 Leader 决策，不自动切换 |
| `role_rotation.interval_minutes` | 正整数 | 两次轮换评估的最短时间间隔（默认 120） |
| `role_rotation.max_switches` | 非负整数 | 本轮工作流最多轮换次数（默认 2） |
| `pass_condition` | string\|null | 通过条件说明 |
| `fail_condition` | string\|null | 失败条件说明 |

## 安全规则

1. 项目配置禁止敏感字段：任意层级的 `secret`、`token`、`api_key`、`password` 键。
2. 项目配置禁止绝对命令路径：Windows 盘符路径（`C:\...`、`C:/...`）、UNC 路径（`\\...`）
   和 POSIX 绝对路径（`/...`）都拒绝。
3. 全局配置同样禁止敏感字段；只允许在全局配置保存单机成立的本机命令。
4. 未知顶层字段、未知 Agent 字段、未知工作流字段和未知步骤字段都允许存在，并在读改写时
   原样保留；已知字段严格按类型校验。敏感字段与绝对路径检测递归扫描所有字段（含未知字段），
   不能借未知字段绕过。
5. 校验失败不部分写入：`config-tool.mjs` 只在全部通过后输出结果。

## 结构化写回（update）

`updateConfigFile(filePath, updates, scope)` / CLI `update --file <path> --scope global|project --set <json>`：

- 读取现有 YAML（目标不存在时从空对象开始），只更新 `--set` 中点分路径指向的字段
  （如 `{"agents.claude.default_role":"leader"}`），保留所有其他对象/数组字段。
- 复用 vendored js-yaml 的 `dump` 写回 YAML；中文注释允许在写回时被规范化丢弃，
  正式字段必须保留。
- 先在同目录临时文件生成并校验（scope=global|project），通过后原子替换目标；
  校验或写入失败时不部分写入，原文件保持不变。Windows 下目标文件已存在时同样以
  替换语义生效（Node `renameSync` 使用 `MOVEFILE_REPLACE_EXISTING`），临时文件与
  目标位于同一目录以保证替换原子性。
- 点路径段禁止 `__proto__`、`prototype`、`constructor`，防止原型污染。
- 配置读写禁止手工字符串拼接或正则修改 YAML，必须使用本命令。

## 合并与规范化输出

`mergeConfig(defaults, globalConfig, projectConfig, runtimeOverrides)` 输出 camelCase 规范化结果：

```json
{
  "defaultWorkflow": "default",
  "workflow": {
    "name": "default",
    "leader": null,
    "implementer": null,
    "reviewer": null,
    "reviewerReadOnly": true,
    "useSuperpowers": true,
    "steps": {},
    "maxRework": 5,
    "takeoverOnExceed": "leader",
    "roleRotation": {
      "enabled": false,
      "intervalMinutes": 120,
      "maxSwitches": 2
    },
    "passCondition": null,
    "failCondition": null
  },
  "agents": {
    "claude": {
      "kind": "claude",
      "command": "claude",
      "elevatedArgs": ["--dangerously-skip-permissions"],
      "elevatedEnabled": true,
      "model": null,
      "modelArgs": [],
      "defaultRole": "reviewer",
      "superpowers": "unknown"
    }
  }
}
```

合并规则：工作流按名字合并（默认 ← 项目），`steps` 按步骤名逐级合并；
`defaultWorkflow` 取运行时覆盖 > 项目 > 默认；运行时 `workflow`/`leader`/`implementer`/`reviewer`
可覆盖选择与角色绑定；角色字段没有显式值时保持 `null`，不得从当前客户端或 Agent 排序推断；
`agents` 只来自全局配置并保留启动参数。

角色轮换只允许发生在当前 Agent 回合结束、评审单轮次完成或返修交接等阶段边界，不能中断正在执行的回合。
`role_rotation.enabled=true` 时，Leader、实施者、审查者必须是至少三个不同 Agent；每次轮换前只提示用户
“两个 Agent 的模型能力不要差距过大”，等待确认后再轮换，不采集或比较真实模型能力。轮换只改变后续任务的角色绑定，
不覆盖全局 Agent 配置；审查者角色仍受 `reviewer_read_only` 约束。

## 错误输出

`config-tool.mjs` 成功时只向 stdout 输出 JSON；错误时向 stderr 输出
`CONFIG_INVALID <字段路径> <原因>`（每个错误一行）并返回 1。
`validate-config.ps1` 在找不到 Node 时输出 `NODE_NOT_FOUND` 并返回 1。

## YAML→JSON 桥接

`check-agents.ps1` 等 PowerShell 脚本需要读取 YAML（如 `agent-adapters.yaml`）时，
必须通过 `node config-tool.mjs to-json --file <path>` 结构化转换，不得在 PowerShell 中
用正则或字符串拼接解析 YAML。找不到 Node 时输出 `NODE_NOT_FOUND` 并返回 1。
