---
name: goal
description: 在 Agent Goal 中启动 Herdr 多 Agent 开发闭环。需要用等待模式完成实施、审核、返修和最终验收，避免事件唤醒与 Goal 冲突时使用。
---

# Herdr goal

1. 完整读取并遵循 `../herdr-workflows/SKILL.md`。
2. 固定使用 `mode=goal`，不得切换到其他 mode。
3. 将用户随本 Skill 提供的其余文本作为运行时参数。
4. 本入口只声明 mode 和参数；不复制或改写核心 Skill 的规则。
