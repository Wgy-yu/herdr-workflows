// 工作流配置工具的回归测试：覆盖合并优先级、中文注释、敏感字段与绝对路径安全规则、
// 未知字段保留与结构化 update 写回。
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseYamlFile,
  validateGlobalConfig,
  validateProjectConfig,
  mergeConfig,
  findForbiddenProjectValues,
  updateConfigFile,
} from "../skills/herdr-workflows/scripts/config-tool.mjs";

const TOOL = fileURLToPath(new URL("../skills/herdr-workflows/scripts/config-tool.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const defaultsFile = fileURLToPath(new URL("../skills/herdr-workflows/assets/defaults.yaml", import.meta.url));
const workflowsSkillFile = fileURLToPath(new URL("../skills/herdr-workflows/SKILL.md", import.meta.url));
const initSkillFile = fileURLToPath(new URL("../skills/init/SKILL.md", import.meta.url));

// 与 assets/defaults.yaml 同形的逻辑默认值：OpenCode 实施、Claude 审核。
const DEFAULTS = {
  default_workflow: "opencode-implement-claude-review",
  workflows: {
    "opencode-implement-claude-review": {
      leader: "codex",
      implementer: "opencode",
      reviewer: "claude",
      reviewer_read_only: true,
      max_rework: 5,
      takeover_on_exceed: "leader",
    },
  },
};

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "config-tool-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("插件默认工作流不预设 Codex 或其他 Agent 为 Leader", () => {
  const defaults = parseYamlFile(defaultsFile);
  const workflow = defaults.workflows[defaults.default_workflow];
  assert.ok(workflow, "默认工作流必须存在");
  assert.equal(workflow.leader, null);
  assert.equal(workflow.implementer, null);
  assert.equal(workflow.reviewer, null);
});

test("init 入口声明配置、Superpowers 与 Agent 直连能力", () => {
  const initSkill = readFileSync(initSkillFile, "utf8");
  const workflowsSkill = readFileSync(workflowsSkillFile, "utf8");
  assert.match(initSkill, /mode=init/);
  assert.match(workflowsSkill, /config-tool\.mjs update/);
  assert.match(workflowsSkill, /Superpowers/);
  assert.match(workflowsSkill, /agent\.prompt/);
  assert.match(workflowsSkill, /agent\.send_keys/);
});

test("项目配置覆盖全局角色但保留全局启动参数", () => {
  const globalConfig = parseYamlFile(fixture("global.yaml"));
  const projectConfig = parseYamlFile(fixture("project.yaml"));
  const merged = mergeConfig(DEFAULTS, globalConfig, projectConfig, {});
  // 项目默认工作流取代逻辑默认工作流。
  assert.equal(merged.defaultWorkflow, "claude-implement-opencode-review");
  assert.equal(merged.workflow.name, "claude-implement-opencode-review");
  // 项目角色绑定覆盖默认角色，而不是使用全局 default_role。
  assert.equal(merged.workflow.implementer, "claude");
  assert.equal(merged.workflow.reviewer, "opencode");
  // 全局启动参数原样保留。
  assert.deepEqual(merged.agents.claude.elevatedArgs, ["--dangerously-skip-permissions"]);
  assert.deepEqual(merged.agents.opencode.elevatedArgs, ["--auto"]);
});

test("命令行覆盖项目默认工作流", () => {
  const globalConfig = parseYamlFile(fixture("global.yaml"));
  const projectConfig = parseYamlFile(fixture("project.yaml"));
  const byRuntime = mergeConfig(DEFAULTS, globalConfig, projectConfig, {
    workflow: "opencode-implement-claude-review",
  });
  assert.equal(byRuntime.workflow.name, "opencode-implement-claude-review");
  assert.equal(byRuntime.workflow.implementer, "opencode");
  assert.equal(byRuntime.workflow.reviewer, "claude");
  // 项目级深度合并覆盖默认工作流的 max_rework。
  assert.equal(byRuntime.workflow.maxRework, 3);
  // 未指定时仍使用项目默认工作流。
  const byDefault = mergeConfig(DEFAULTS, globalConfig, projectConfig, {});
  assert.equal(byDefault.workflow.name, "claude-implement-opencode-review");
});

test("UTF-8 中文注释不影响解析", () => {
  const config = parseYamlFile(fixture("global.yaml"));
  // 注释不成为字段，只解析出正式字段。
  assert.deepEqual(Object.keys(config), ["agents"]);
  assert.equal(config.agents.claude.elevated_args[0], "--dangerously-skip-permissions");
  assert.equal(config.agents.opencode.elevated_args[0], "--auto");
});

test("项目配置拒绝 secret token api_key password 字段", () => {
  const config = parseYamlFile(fixture("unsafe.yaml"));
  const errors = validateProjectConfig(config);
  for (const field of ["$.api_key", "$.secret", "$.token", "$.password"]) {
    assert.ok(
      errors.some((error) => error.includes(field)),
      `缺少敏感字段 ${field} 的校验错误，实际错误：${JSON.stringify(errors)}`
    );
  }
  const forbiddenPaths = findForbiddenProjectValues(config).map((item) => item.path);
  for (const field of ["$.api_key", "$.secret", "$.token", "$.password"]) {
    assert.ok(forbiddenPaths.includes(field), `findForbiddenProjectValues 未报告 ${field}`);
  }
});

test("项目配置拒绝 Windows 和 POSIX 绝对命令路径", () => {
  const config = parseYamlFile(fixture("unsafe.yaml"));
  const errors = validateProjectConfig(config);
  const pathErrors = errors.filter((error) => error.includes("绝对"));
  assert.ok(
    pathErrors.some((error) => error.includes("$.commands[0]")),
    `缺少 Windows 绝对路径错误，实际错误：${JSON.stringify(errors)}`
  );
  assert.ok(
    pathErrors.some((error) => error.includes("$.commands[1]")),
    `缺少 POSIX 绝对路径错误，实际错误：${JSON.stringify(errors)}`
  );
});

test("未知顶层字段与工作流内未知字段允许保留", () => {
  const projectErrors = validateProjectConfig({
    unknown_top: { nested: 1 },
    workflows: { "some-workflow": { leader: "codex", custom_flag: true } },
  });
  assert.deepEqual(projectErrors, []);
  const globalErrors = validateGlobalConfig({
    unexpected_field: "x",
    agents: { claude: { command: "claude", custom_launch_note: "本机备注" } },
  });
  assert.deepEqual(globalErrors, []);
});

test("已知字段类型错误仍拒绝", () => {
  const projectErrors = validateProjectConfig({
    workflows: { "some-workflow": { leader: "codex", max_rework: "五" } },
  });
  assert.ok(
    projectErrors.some((error) => error.includes("max_rework")),
    `已知字段类型错误未被拒绝，实际错误：${JSON.stringify(projectErrors)}`
  );
  const globalErrors = validateGlobalConfig({
    agents: { claude: { command: "claude", elevated_args: "非数组" } },
  });
  assert.ok(
    globalErrors.some((error) => error.includes("elevated_args")),
    `已知字段类型错误未被拒绝，实际错误：${JSON.stringify(globalErrors)}`
  );
});

test("未知字段中的敏感字段和绝对路径仍拒绝", () => {
  const errors = validateProjectConfig({
    custom_section: {
      api_key: "[REDACTED_SECRET]",
      tools: ["C:\\tools\\x.exe", "/usr/bin/y"],
    },
  });
  for (const path of ["$.custom_section.api_key", "$.custom_section.tools[0]", "$.custom_section.tools[1]"]) {
    assert.ok(
      errors.some((error) => error.includes(path)),
      `未知字段中的禁止值 ${path} 未被拒绝，实际错误：${JSON.stringify(errors)}`
    );
  }
});

test("update 保留不相关 Agent 与未知字段，只改明确路径", () => {
  const dir = makeTempDir();
  const file = join(dir, "config.yaml");
  writeFileSync(
    file,
    [
      "# 全局配置：中文注释允许在写回时被规范化丢弃。",
      "agents:",
      "  claude:",
      "    command: claude",
      "    elevated_args:",
      "      - --dangerously-skip-permissions",
      "    default_role: reviewer",
      "  opencode:",
      "    command: opencode",
      "    elevated_args:",
      "      - --auto",
      "custom_top:",
      "  keep_me: true",
      "",
    ].join("\n"),
    "utf8"
  );
  const result = updateConfigFile(file, { "agents.claude.default_role": "leader" }, "global");
  assert.equal(result.updated, true, `update 应成功，实际：${JSON.stringify(result)}`);
  const next = parseYamlFile(file);
  assert.equal(next.agents.claude.default_role, "leader");
  // 不相关 Agent 与未知字段原样保留。
  assert.equal(next.agents.opencode.command, "opencode");
  assert.deepEqual(next.agents.opencode.elevated_args, ["--auto"]);
  assert.deepEqual(next.custom_top, { keep_me: true });
});

test("update 校验失败不写入原文件", () => {
  const dir = makeTempDir();
  const file = join(dir, "workflows.yaml");
  const original = [
    "default_workflow: claude-implement-opencode-review",
    "workflows:",
    "  claude-implement-opencode-review:",
    "    leader: codex",
    "    implementer: claude",
    "    reviewer: opencode",
    "    max_rework: 5",
    "",
  ].join("\n");
  writeFileSync(file, original, "utf8");
  const result = updateConfigFile(
    file,
    { "workflows.claude-implement-opencode-review.max_rework": "五" },
    "project"
  );
  assert.equal(result.updated, false);
  assert.ok(
    result.errors.some((error) => error.includes("max_rework")),
    `校验错误应包含字段路径，实际：${JSON.stringify(result.errors)}`
  );
  assert.equal(readFileSync(file, "utf8"), original, "校验失败时原文件必须保持不变");
});

test("update 写入失败原文件不变（不依赖文件权限）", () => {
  const dir = makeTempDir();
  const file = join(dir, "workflows.yaml");
  const original = [
    "default_workflow: claude-implement-opencode-review",
    "workflows:",
    "  claude-implement-opencode-review:",
    "    leader: codex",
    "    max_rework: 5",
    "",
  ].join("\n");
  writeFileSync(file, original, "utf8");
  // 用同名目录占住临时文件路径，使写临时文件必然失败；不依赖只读 chmod。
  mkdirSync(join(dir, `workflows.yaml.tmp-${process.pid}`));
  const result = updateConfigFile(file, { "workflows.claude-implement-opencode-review.max_rework": 4 }, "project");
  assert.equal(result.updated, false, `update 应失败，实际：${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some((error) => error.includes("写入失败")),
    `错误应说明写入失败，实际：${JSON.stringify(result.errors)}`
  );
  assert.equal(readFileSync(file, "utf8"), original, "写入失败时原文件必须保持不变");
});

test("update 拒绝 __proto__/prototype/constructor 点路径", () => {
  const dir = makeTempDir();
  const file = join(dir, "workflows.yaml");
  const original = [
    "default_workflow: claude-implement-opencode-review",
    "workflows:",
    "  claude-implement-opencode-review:",
    "    leader: codex",
    "    max_rework: 5",
    "",
  ].join("\n");
  writeFileSync(file, original, "utf8");
  for (const path of ["__proto__.polluted", "agents.claude.constructor", "prototype.x"]) {
    const result = updateConfigFile(file, { [path]: true }, "project");
    assert.equal(result.updated, false, `${path} 应被拒绝，实际：${JSON.stringify(result)}`);
    assert.ok(
      result.errors.some((error) => error.includes(path)),
      `${path} 的错误应包含路径，实际：${JSON.stringify(result.errors)}`
    );
  }
  assert.equal(readFileSync(file, "utf8"), original, "被拒绝的 update 不得修改原文件");
});

test("update 新文件场景：目标不存在时创建并写入", () => {
  const dir = makeTempDir();
  const file = join(dir, "new-workflows.yaml");
  const result = updateConfigFile(file, { "workflows.demo.max_rework": 3 }, "project");
  assert.equal(result.updated, true, `update 应成功，实际：${JSON.stringify(result)}`);
  assert.ok(existsSync(file));
  const next = parseYamlFile(file);
  assert.equal(next.workflows.demo.max_rework, 3);
});

test("update CLI 端到端", () => {
  const dir = makeTempDir();
  const file = join(dir, "workflows.yaml");
  writeFileSync(
    file,
    ["workflows:", "  demo:", "    leader: codex", "    max_rework: 5", ""].join("\n"),
    "utf8"
  );
  const proc = spawnSync(
    process.execPath,
    [TOOL, "update", "--file", file, "--scope", "project", "--set", '{"workflows.demo.max_rework":4}'],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `CLI 应成功，stderr=${proc.stderr}`);
  assert.ok(JSON.parse(proc.stdout).updated === true, `stdout 应为 updated:true，实际：${proc.stdout}`);
  assert.equal(parseYamlFile(file).workflows.demo.max_rework, 4);
});
