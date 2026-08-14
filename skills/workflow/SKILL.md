---
name: workflow
description: 配置项目级 Herdr 多智能体工作流。用户要求设置角色绑定、步骤顺序、审查门禁或返修次数时使用。
---

# Herdr workflow

1. 完整读取并遵循 `../herdr-workflows/SKILL.md`。
2. 固定使用 `mode=workflow`，不得切换到其他 mode。
3. 将用户随本 Skill 提供的其余文本作为运行时参数。
4. 本入口只声明 mode 和参数；不复制或改写核心 Skill 的规则。
