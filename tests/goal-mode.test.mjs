import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("goal 薄入口固定选择同步等待模式", () => {
  const skill = read("../skills/goal/SKILL.md");

  assert.match(skill, /^name: goal$/m);
  assert.match(skill, /固定使用 `mode=goal`/);
  assert.match(skill, /\.\.\/herdr-workflows\/SKILL\.md/);
});

test("goal 复用初始 do 的完整闭环并固定使用 wait 推进", () => {
  const skill = read("../skills/herdr-workflows/SKILL.md");

  assert.match(skill, /`mode=goal`：启动适配 Agent Goal 的等待式开发实施闭环/);
  assert.match(skill, /计划读取回执（逐字符核对）/);
  assert.match(skill, /实施者修改代码并提供 diff 与验证证据/);
  assert.match(skill, /superpowers:receiving-code-review/);
  assert.match(skill, /max_rework/);
  assert.match(skill, /takeover_on_exceed/);
  assert.match(skill, /Leader 独立运行项目检查并作最终裁决/);
  assert.match(skill, /agent\.wait/);
  assert.match(skill, /mode=goal[^\n]*不使用事件桥/);
  assert.match(skill, /mode=goal[^\n]*不调用[^\n]*dispatch/);
  assert.match(skill, /mode=do[^；]*Herdr 官方状态事件/);
});

test("goal UI 元数据可被插件发现", () => {
  const metadata = read("../skills/goal/agents/openai.yaml");

  assert.match(metadata, /display_name: "Herdr Goal"/);
  assert.match(metadata, /\$goal/);
  assert.ok(root.length > 0);
});
