---
name: review
description: 启动 Herdr 多 Agent 共享 Markdown 评审。用户要求多智能体复核代码、沉淀评审单、比对审查意见或输出审查结论时使用。
---

# Herdr review

1. 完整读取并遵循 `../herdr-workflows/SKILL.md`。
2. 固定使用 `mode=review`，不得切换到其他 mode。
3. 将用户随本 Skill 提供的其余文本作为运行时参数。
4. 本入口只声明 mode 和参数；不复制或改写核心 Skill 的规则。
