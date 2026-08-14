# herdr-workflows

`herdr-workflows` 是一个外置的 Codex Plugin + Herdr Plugin，用于配置和运行多 Agent 工作流。
它不修改官方 Herdr，Leader、实施者和审查者可以通过 Herdr 直接通信。

## 能做什么

- 初始化 Agent、Superpowers 和项目工作流。
- 使用共享 Markdown 评审单，审查者对业务源码保持只读。
- 通过 Herdr 事件桥接减少 Leader 等待：实施者完成后直达审查者，审查者完成后直达 Leader。
- 配置是否使用 Superpowers。
- 在满足三个不同 Agent 的前提下，按阶段边界轮换实施者和审查者。
- 轮换前只提示用户注意模型能力差距，不读取或比较真实模型能力。

## 安装

### 安装 Codex Plugin

Codex Plugin 通过本仓库主 Marketplace 安装：

```powershell
git clone http://jawasoft.com.cn:9380/idmp/skill.git
codex plugin marketplace add .\skill
codex plugin add herdr-workflows@wgy-workflows
```

安装或升级后，新建一个 Codex 任务以加载最新 Skill。

### 安装 Herdr 事件桥接

在 Herdr 管理的 Agent 窗格中执行：

```powershell
herdr plugin install Wgy-yu/herdr-workflows --yes
herdr plugin list --plugin wgy.herdr-workflows-bridge
```

要求 Herdr `0.7.0` 或更高版本。插件监听 `pane.agent_status_changed`，使用官方 Socket API
的 `agent.list` 和 `agent.prompt`，不修改 Herdr 源码。

如需本地开发桥接：

```powershell
herdr plugin link <本地 herdr-workflows 目录>
herdr plugin list --plugin wgy.herdr-workflows-bridge
```

## 安装 Claude、OpenCode 并接入 Herdr

`herdr-workflows` 不会替用户安装第三方 Agent；先按 Agent 官方方式安装，再让 Herdr
安装对应的集成。安装完成后，使用 `herdr agent start` 时的 `--kind` 必须使用下面的
官方 kind 名称。

### Claude Code

Windows PowerShell：

```powershell
irm https://claude.ai/install.ps1 | iex
```

macOS、Linux 或 WSL：

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

也可以使用 Windows WinGet（`winget install Anthropic.ClaudeCode`）或 macOS Homebrew
（`brew install --cask claude-code`）。安装后验证并登录：

```text
claude --version
claude
/login
```

在 Herdr 中安装生命周期集成，并在空闲 shell 窗格启动：

```powershell
herdr integration install claude
herdr agent start claude-implementer --kind claude --pane <pane-id>
```

### OpenCode

macOS、Linux、WSL 或其他 Unix shell 的官方快速安装：

```bash
curl -fsSL https://opencode.ai/install | bash
```

Windows 推荐使用 WSL；也可以直接使用 Chocolatey、Scoop 或 npm：

```powershell
choco install opencode
scoop install opencode
npm install -g opencode-ai
```

macOS/Linux 还可以使用最新 Homebrew tap：

```bash
brew install anomalyco/tap/opencode
```

安装后验证并在 TUI 中执行 `/connect` 配置模型提供商：

```text
opencode --version
opencode
/connect
```

在 Herdr 中安装 OpenCode 集成并启动：

```powershell
herdr integration install opencode
herdr agent start opencode-reviewer --kind opencode --pane <pane-id>
```

`<pane-id>` 必须是当前处于交互式 shell 提示符的空闲窗格。Agent 名称需唯一，且只能由
小写字母、数字、`_` 和 `-` 组成；也可以直接在窗格中手动运行 `claude` 或 `opencode`，
再用 `herdr agent rename <pane-id> <name>` 设置稳定名称。

## Herdr 官方支持的 Agent

以 Herdr 官方 `agent start --kind` 文档为准，目前共有 **21 个官方 kind**：

```text
pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode,
opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, maki
```

其中 `agy` 对应 Agents 文档中的 Antigravity CLI。官方 Agents 页面将前 19 个列为主支持
列表，并注明 Gemini CLI、Cline 已能检测但测试较少；未安装专用集成的 Agent 仍可作为
普通终端进程运行，只是状态信息可能只有屏幕检测，不能获得完整生命周期状态。

Herdr 的官方直接集成目前提供以下 16 个安装项（集成数量不等于支持的 Agent 总数）：

```text
pi, omp, claude, codex, copilot, devin, droid, kimi,
opencode, kilo, hermes, qodercli, cursor, mastracode,
antigravity-cli, grok
```

按需执行，例如：

```powershell
herdr integration install claude
herdr integration install opencode
herdr integration status
herdr agent list
```

完整状态权威、集成角色和 kind 说明请以 [Herdr Agents 文档](https://herdr.dev/docs/agents/)、
[Agent automation 文档](https://herdr.dev/docs/agent-automation/) 和
[Integrations 文档](https://herdr.dev/docs/integrations/) 为准。

## 命令

在 Codex 中使用以下入口：

| 命令 | 用途 |
| --- | --- |
| `$herdr-workflows:init` | 首次安装向导：检查 Agent、配置 Superpowers、绑定项目角色和注册桥接 |
| `$herdr-workflows:check` | 只读检查 Agent、启动适配器和 Superpowers 状态 |
| `$herdr-workflows:config` | 配置本机 Agent 命令、模型参数、权限参数和默认角色 |
| `$herdr-workflows:workflow` | 配置项目角色、步骤、Superpowers 开关和角色轮换 |
| `$herdr-workflows:review` | 创建共享 Markdown 评审单并执行只读审查 |
| `$herdr-workflows:do` | 执行设计、计划、实施、审查、返修和最终裁决闭环 |

推荐首次使用：

```text
$herdr-workflows:init
```

## 项目配置

配置文件为 `<repo>/.herdr/workflows.yaml`，使用结构化工具写入，不要手工拼接 YAML。

```yaml
default_workflow: default
workflows:
  default:
    leader: codex-leader
    implementer: opencode-editor
    reviewer: claude-reviewer
    reviewer_read_only: true
    use_superpowers: true
    role_rotation:
      enabled: false
      interval_minutes: 120
      max_switches: 2
```

### `use_superpowers`

- `true`（默认）：执行工作流中声明的 `superpowers:*` Skill，并检查/安装对应 Agent 的 Superpowers。
- `false`：跳过 Superpowers Skill、安装和门禁，但保留角色、审查只读和 Leader 最终裁决规则。

### `role_rotation`

只有 `leader`、`implementer`、`reviewer` 是三个不同 Agent 时，才允许：

```yaml
role_rotation:
  enabled: true
  interval_minutes: 120
  max_switches: 2
```

轮换只发生在当前回合结束、评审轮次完成或返修交接等阶段边界。每次轮换前会提示：
“两个 Agent 的模型能力不要差距过大”，等待用户确认后才切换；插件不会配置或评测能力等级。

## 事件桥接行为

桥接启用后：

1. 实施者进入 `done`：直接通知审查者读取共享评审单并开始审查。
2. 审查者进入 `done`：直接通知 Leader 读取评审单并进行最终裁决。
3. 实施者或审查者进入 `blocked`：直接通知 Leader 处理阻塞。
4. 目标 Agent 不可用：退回 Herdr `notification.show`，不让 Leader 充当消息中继。
5. 事件追加到 `<repo>/.herdr/workflow-events.jsonl`，带状态序号的重复事件不会重复通知。

查看桥接日志：

```powershell
herdr plugin log list --plugin wgy.herdr-workflows-bridge --limit 50
```

## 评审与开发约束

- `review` 模式只允许创建或追加共享 Markdown 评审单，不修改业务源码。
- Reviewer 始终只读；最大权限参数不等于业务写权限。
- Agent 之间直接发送交接信息，长篇证据写入评审单或事件记录。
- Leader 保留最终裁决，不因事件桥接而取消验收责任。

## 更新与卸载

更新 Codex Plugin：

```powershell
codex plugin add herdr-workflows@wgy-workflows
```

更新 Herdr 桥接：

```powershell
herdr plugin install Wgy-yu/herdr-workflows --yes
```

卸载 Herdr 桥接：

```powershell
herdr plugin uninstall wgy.herdr-workflows-bridge
```

## 常见检查

```powershell
herdr plugin list --plugin wgy.herdr-workflows-bridge
herdr plugin log list --plugin wgy.herdr-workflows-bridge --limit 50
node skills/herdr-workflows/scripts/config-tool.mjs validate --scope project --file .herdr/workflows.yaml
node skills/herdr-workflows/scripts/config-tool.mjs merge `
  --defaults skills/herdr-workflows/assets/defaults.yaml `
  --project .herdr/workflows.yaml
```

如果桥接没有通知 Agent，先确认：项目配置三类角色已绑定、角色名称与 Herdr Agent 名称一致、
Herdr 版本满足要求，并检查 `workflow-events.jsonl` 和插件日志。
