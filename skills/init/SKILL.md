---
name: init
description: Use when the Codex Herdr Workflows plugin needs first-run Agent checks, role selection, Superpowers onboarding, global configuration, or project workflow setup.
---

# Herdr init

1. 完整读取并遵循 `../herdr-workflows/SKILL.md`。
2. 固定使用 `mode=init`，不得切换到其他 mode。
3. 将用户随本 Skill 提供的项目路径、模板、角色和任务正文作为初始化运行时参数；缺少的选择由向导询问。
4. 初始化交互、模板选择和角色确认由本 Agent Skill 完成；Codex 使用核心 Skill 指定的结构化
   配置工具写入并校验项目配置，用户无需手工创建 YAML。
5. 本入口只声明 mode 和参数；初始化顺序、角色选择、Superpowers 安装和 Agent 直连规则只在核心 Skill 维护。
