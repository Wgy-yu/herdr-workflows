# Herdr 多 Agent 评审单

> 本文档是本轮评审的唯一持久事实源。所有参与 Agent 只能在文件末尾按轮次追加；
> 不得删除、覆盖、重排既有内容。纠错请追加新轮次说明。

## 基线

- 评审 ID：`{{review_id}}`
- 目标：`{{target}}`
- 仓库：`{{repository}}`
- 分支：`{{branch}}`
- HEAD：`{{head}}`
- 创建时间：`{{created_at}}`
- Leader：`{{leader}}`
- 参与 Agent：`{{participants}}`
- 审查前工作树：`{{git_status_summary}}`

---

## 轮次 `{{round_id}}`：`{{round_title}}`

- 作者：`{{agent}}`
- 角色：`{{role}}`
- 时间：`{{timestamp}}`
- 上一轮：`{{previous_round_id_or_none}}`

### 结论

`{{round_conclusion}}`

### 证据

| 问题 ID | 严重度 | 文件与行号 | 证据及影响 |
| --- | --- | --- | --- |
| `F-001` | `P1` | `path/to/file:line` | `{{evidence_and_impact}}` |

### 确认/驳回

| 问题 ID | 决定 | 理由与证据 |
| --- | --- | --- |
| `F-001` | `确认 / 驳回 / 待确认 / 新增` | `{{reason_and_evidence}}` |

### 交接

- 下一 Agent：`{{next_agent_or_leader}}`
- 交接定位：`{{review_sheet_path}}#{{round_anchor}}`
- 待处理问题 ID：`{{finding_ids_or_none}}`

---

## 最终裁决 `{{final_round_id}}`

- 裁决者：`{{leader}}`
- 时间：`{{timestamp}}`
- 裁决：`REVIEW_CHANGES_REQUIRED / REVIEW_PASS`
- 有效问题 ID：`{{finding_ids_or_none}}`
- 最终结论：`{{final_ruling}}`
