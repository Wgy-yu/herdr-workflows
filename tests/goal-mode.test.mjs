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

test("goal 与 do 共享契约并只在能力存在时选择 Goal 适配器", () => {
  const skill = read("../skills/herdr-workflows/SKILL.md");

  assert.match(skill, /`mode=goal`：启动适配 Agent Goal 的等待式开发实施闭环/);
  assert.match(skill, /`do` 与 `goal` 只选择执行适配器/);
  assert.match(skill, /\.herdr\/workflow\/contract\.json/);
  assert.match(skill, /frontend-backend/);
  assert.match(skill, /一次性 token/);
  assert.match(skill, /max_rework/);
  assert.match(skill, /只有该裁决可以结束工作流/);
  assert.match(skill, /明确声明 Goal 能力/);
  assert.match(skill, /fallback/);
  assert.match(skill, /idle.*done.*unknown/);
});

test("goal UI 元数据可被插件发现", () => {
  const metadata = read("../skills/goal/agents/openai.yaml");

  assert.match(metadata, /display_name: "Herdr Goal"/);
  assert.match(metadata, /\$goal/);
  assert.ok(root.length > 0);
});
