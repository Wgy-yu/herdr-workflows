---
name: init
description: Use when a newly installed Herdr plugin needs first-run Agent checks, role selection, Superpowers onboarding, global configuration, or project workflow setup.
---

# Herdr init

1. 完整读取并遵循 `../herdr-workflows/SKILL.md`。
2. 固定使用 `mode=init`，不得切换到其他 mode。
3. 将用户随本 Skill 提供的其余文本作为初始化运行时参数。
4. 本入口只声明 mode 和参数；初始化顺序、角色选择、Superpowers 安装和 Agent 直连规则只在核心 Skill 维护。
