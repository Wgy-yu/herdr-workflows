// herdr-workflows 结构化 YAML 配置工具。
// 使用插件内固定分发的 js-yaml（../vendor/js-yaml.mjs）解析配置，
// 不依赖宿主项目依赖，也不使用正则或字符串拼接解析 YAML。
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { load as yamlLoad, dump as yamlDump, JSON_SCHEMA } from "../vendor/js-yaml.mjs";

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export function parseYamlFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`读取配置文件失败，path=${path}，error=${error.message}`);
  }
  let value;
  try {
    // JSON_SCHEMA 保证输出只有普通对象/数组/字符串/数字/布尔/null，
    // 不会把时间戳字符串解析成 Date 对象。
    value = yamlLoad(text, { schema: JSON_SCHEMA });
  } catch (error) {
    throw new Error(`解析 YAML 失败，path=${path}，error=${error.message}`);
  }
  if (value === null || value === undefined) {
    throw new Error(`配置文件为空，path=${path}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 安全规则
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY_RE = /^(secret|token|api_key|password)$/i;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const UNC_ABS_RE = /^\\\\/;
const POSIX_ABS_RE = /^\//;

function isAbsolutePath(text) {
  return WINDOWS_ABS_RE.test(text) || UNC_ABS_RE.test(text) || POSIX_ABS_RE.test(text);
}

/**
 * 找出配置中的禁止值。
 * 敏感字段（secret/token/api_key/password）在所有作用域都禁止；
 * 绝对命令路径只禁止出现在项目配置中。
 */
export function findForbiddenProjectValues(value, path = "$") {
  return findForbiddenValues(value, path, { absolutePathsForbidden: true });
}

function findForbiddenValues(value, path = "$", options = {}) {
  const findings = [];
  const walk = (node, nodePath) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${nodePath}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) {
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      const childPath = `${nodePath}.${key}`;
      if (FORBIDDEN_KEY_RE.test(key)) {
        findings.push({ path: childPath, reason: "包含敏感字段" });
      }
      walk(item, childPath);
    }
  };
  const walkScalars = (node, nodePath) => {
    if (typeof node === "string") {
      if (options.absolutePathsForbidden && isAbsolutePath(node)) {
        findings.push({ path: nodePath, reason: "绝对命令路径" });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walkScalars(item, `${nodePath}[${index}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        walkScalars(item, `${nodePath}.${key}`);
      }
    }
  };
  walk(value, path);
  walkScalars(value, path);
  return findings;
}

// ---------------------------------------------------------------------------
// 模式校验
// ---------------------------------------------------------------------------

/** 校验全局配置（本机 Agent 定义），返回错误列表，空数组表示通过。 */
export function validateGlobalConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    errors.push("$ 必须是对象");
    return errors;
  }
  // 未知顶层字段与未知 Agent 字段允许保留（读改写时原样保留），只严格校验已知字段。
  const agents = value.agents;
  if (agents !== undefined && agents !== null) {
    if (!isPlainObject(agents)) {
      errors.push("$.agents 必须是对象");
    } else {
      for (const [id, entry] of Object.entries(agents)) {
        const base = `$.agents.${id}`;
        if (!isPlainObject(entry)) {
          errors.push(`${base} 必须是对象`);
          continue;
        }
        for (const key of ["kind", "command", "model", "default_role", "superpowers"]) {
          const field = entry[key];
          if (field !== undefined && field !== null && typeof field !== "string") {
            errors.push(`${base}.${key} 必须是字符串或 null`);
          }
        }
        for (const key of ["elevated_args", "model_args"]) {
          const field = entry[key];
          if (field !== undefined && field !== null) {
            if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
              errors.push(`${base}.${key} 必须是字符串数组`);
            }
          }
        }
        if (
          entry.elevated_enabled !== undefined &&
          entry.elevated_enabled !== null &&
          typeof entry.elevated_enabled !== "boolean"
        ) {
          errors.push(`${base}.elevated_enabled 必须是布尔值`);
        }
      }
    }
  }
  // 全局配置允许本机绝对路径，但仍禁止敏感字段。
  for (const item of findForbiddenValues(value, "$", { absolutePathsForbidden: false })) {
    errors.push(`${item.path} ${item.reason}`);
  }
  return errors;
}

/** 校验项目配置（可共享工作流），返回错误列表，空数组表示通过。 */
export function validateProjectConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    errors.push("$ 必须是对象");
    return errors;
  }
  // 未知顶层字段、工作流字段与步骤字段允许保留，只严格校验已知字段。
  if (
    value.default_workflow !== undefined &&
    value.default_workflow !== null &&
    typeof value.default_workflow !== "string"
  ) {
    errors.push("$.default_workflow 必须是字符串");
  }
  const workflows = value.workflows;
  if (workflows !== undefined && workflows !== null) {
    if (!isPlainObject(workflows)) {
      errors.push("$.workflows 必须是对象");
    } else {
      for (const [name, workflow] of Object.entries(workflows)) {
        const base = `$.workflows.${name}`;
        if (!isPlainObject(workflow)) {
          errors.push(`${base} 必须是对象`);
          continue;
        }
        for (const key of [
          "leader",
          "implementer",
          "reviewer",
          "takeover_on_exceed",
          "pass_condition",
          "fail_condition",
        ]) {
          const field = workflow[key];
          if (field !== undefined && field !== null && typeof field !== "string") {
            errors.push(`${base}.${key} 必须是字符串或 null`);
          }
        }
        if (
          workflow.reviewer_read_only !== undefined &&
          workflow.reviewer_read_only !== null &&
          typeof workflow.reviewer_read_only !== "boolean"
        ) {
          errors.push(`${base}.reviewer_read_only 必须是布尔值`);
        }
        if (
          workflow.use_superpowers !== undefined &&
          workflow.use_superpowers !== null &&
          typeof workflow.use_superpowers !== "boolean"
        ) {
          errors.push(`${base}.use_superpowers 必须是布尔值`);
        }
        if (workflow.event_bridge_required !== undefined && workflow.event_bridge_required !== null) {
          if (workflow.event_bridge_required !== true) {
            errors.push(`${base}.event_bridge_required 必须为 true；事件驱动是强制门禁`);
          }
        }
        if (
          workflow.max_rework !== undefined &&
          workflow.max_rework !== null &&
          (!Number.isInteger(workflow.max_rework) || workflow.max_rework < 0)
        ) {
          errors.push(`${base}.max_rework 必须是非负整数`);
        }
        const rotation = workflow.role_rotation;
        if (rotation !== undefined && rotation !== null) {
          if (!isPlainObject(rotation)) {
            errors.push(`${base}.role_rotation 必须是对象`);
          } else {
            if (rotation.enabled !== undefined && rotation.enabled !== null && typeof rotation.enabled !== "boolean") {
              errors.push(`${base}.role_rotation.enabled 必须是布尔值`);
            }
            if (
              rotation.interval_minutes !== undefined &&
              rotation.interval_minutes !== null &&
              (!Number.isInteger(rotation.interval_minutes) || rotation.interval_minutes < 1)
            ) {
              errors.push(`${base}.role_rotation.interval_minutes 必须是正整数`);
            }
            if (
              rotation.max_switches !== undefined &&
              rotation.max_switches !== null &&
              (!Number.isInteger(rotation.max_switches) || rotation.max_switches < 0)
            ) {
              errors.push(`${base}.role_rotation.max_switches 必须是非负整数`);
            }
            if (rotation.enabled === true) {
              const distinctRoles = new Set(
                [workflow.leader, workflow.implementer, workflow.reviewer].filter(
                  (role) => typeof role === "string" && role.trim() !== ""
                )
              );
              if (distinctRoles.size < 3) {
                errors.push(
                  `${base}.role_rotation.enabled=true 时必须配置至少三个不同 Agent（Leader、实施者、审查者）`
                );
              }
            }
          }
        }
        if (workflow.steps !== undefined && workflow.steps !== null) {
          if (!isPlainObject(workflow.steps)) {
            errors.push(`${base}.steps 必须是对象`);
          } else {
            for (const [stepName, step] of Object.entries(workflow.steps)) {
              const stepBase = `${base}.steps.${stepName}`;
              if (!isPlainObject(step)) {
                errors.push(`${stepBase} 必须是对象`);
                continue;
              }
              if (
                step.enabled !== undefined &&
                step.enabled !== null &&
                typeof step.enabled !== "boolean"
              ) {
                errors.push(`${stepBase}.enabled 必须是布尔值`);
              }
              if (
                step.skill !== undefined &&
                step.skill !== null &&
                typeof step.skill !== "string"
              ) {
                errors.push(`${stepBase}.skill 必须是字符串或 null`);
              }
            }
          }
        }
      }
    }
  }
  // 项目配置禁止敏感字段和绝对命令路径。
  for (const item of findForbiddenProjectValues(value)) {
    errors.push(`${item.path} ${item.reason}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 结构化写回（update）
// ---------------------------------------------------------------------------

// 点路径段黑名单：防止通过字段路径触发原型污染。
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * 按点分路径设置对象字段，中间层缺失时创建对象。
 * 只支持对象路径（如 `agents.claude.default_role`）；数组作为叶子整体赋值。
 */
function setByPath(target, path, value) {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return;
  }
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!isPlainObject(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * 结构化更新配置文件：读取现有 YAML（不存在时从空对象开始），只更新 `updates`
 * 中的明确字段路径，保留所有其他对象/数组字段，以 YAML 写回。
 * 先在同目录临时文件生成并校验（scope=global|project），通过后原子替换目标；
 * 校验或写入失败时不部分写入，返回 `{updated: false, errors}`。
 * 中文注释允许在写回时被规范化丢弃，正式字段必须保留。
 */
export function updateConfigFile(filePath, updates, scope) {
  let base;
  try {
    base = existsSync(filePath) ? parseYamlFile(filePath) : {};
  } catch (error) {
    return { updated: false, errors: [error.message] };
  }
  const next = structuredClone(base);
  for (const [path, value] of Object.entries(updates ?? {})) {
    const segments = path.split(".").filter((segment) => segment.length > 0);
    if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
      return { updated: false, errors: [`禁止的字段路径，path=${path}`] };
    }
    setByPath(next, path, value);
  }
  const errors =
    scope === "global"
      ? validateGlobalConfig(next)
      : scope === "project"
        ? validateProjectConfig(next)
        : [`--scope 必须为 global 或 project，scope=${scope}`];
  if (errors.length > 0) {
    return { updated: false, errors };
  }
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, yamlDump(next), "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能尚未创建，忽略清理失败。
    }
    return { updated: false, errors: [`写入失败，file=${filePath}，error=${error.message}`] };
  }
  return { updated: true, errors: [] };
}

// ---------------------------------------------------------------------------
// 合并与规范化
// ---------------------------------------------------------------------------

/**
 * 合并默认、全局、项目与运行时覆盖，输出规范化（camelCase）的有效配置。
 * 优先级从高到低：runtimeOverrides > projectConfig > globalConfig > defaults。
 * @returns {{defaultWorkflow: string, workflow: object, agents: object}}
 */
export function mergeConfig(defaults, globalConfig, projectConfig, runtimeOverrides) {
  const defaultsObj = isPlainObject(defaults) ? defaults : {};
  const globalObj = isPlainObject(globalConfig) ? globalConfig : {};
  const projectObj = isPlainObject(projectConfig) ? projectConfig : {};
  const runtime = isPlainObject(runtimeOverrides) ? runtimeOverrides : {};

  // 工作流按名字合并：默认值 ← 项目覆盖；steps 再按步骤名逐级合并。
  const workflows = {};
  for (const [name, workflow] of Object.entries(defaultsObj.workflows ?? {})) {
    if (isPlainObject(workflow)) {
      workflows[name] = { ...workflow };
    }
  }
  for (const [name, workflow] of Object.entries(projectObj.workflows ?? {})) {
    if (!isPlainObject(workflow)) {
      continue;
    }
    const merged = { ...(workflows[name] ?? {}), ...workflow };
    const defaultSteps = isPlainObject(workflows[name]?.steps) ? workflows[name].steps : {};
    if (isPlainObject(workflow.steps)) {
      merged.steps = { ...defaultSteps };
      for (const [stepName, step] of Object.entries(workflow.steps)) {
        merged.steps[stepName] = {
          ...(merged.steps[stepName] ?? {}),
          ...(isPlainObject(step) ? step : {}),
        };
      }
    }
    workflows[name] = merged;
  }

  const defaultWorkflow =
    runtime.workflow ?? projectObj.default_workflow ?? defaultsObj.default_workflow ?? null;
  if (defaultWorkflow === null) {
    throw new Error("未指定默认工作流，default_workflow 缺失");
  }
  const workflow = workflows[defaultWorkflow];
  if (!isPlainObject(workflow)) {
    throw new Error(`未找到工作流，name=${defaultWorkflow}`);
  }

  return {
    defaultWorkflow,
    workflow: normalizeWorkflow(defaultWorkflow, workflow, runtime),
    agents: normalizeAgents(globalObj.agents ?? {}),
  };
}

function normalizeWorkflow(name, workflow, runtime) {
  const steps = {};
  for (const [stepName, step] of Object.entries(workflow.steps ?? {})) {
    if (isPlainObject(step)) {
      const normalized = { enabled: step.enabled ?? true };
      if (step.skill !== undefined) {
        normalized.skill = step.skill ?? null;
      }
      steps[stepName] = normalized;
    }
  }
  return {
    name,
    leader: runtime.leader ?? workflow.leader ?? null,
    implementer: runtime.implementer ?? workflow.implementer ?? null,
    reviewer: runtime.reviewer ?? workflow.reviewer ?? null,
    reviewerReadOnly: workflow.reviewer_read_only ?? true,
    useSuperpowers: workflow.use_superpowers ?? true,
    eventBridgeRequired: workflow.event_bridge_required ?? true,
    steps,
    maxRework: workflow.max_rework ?? 5,
    takeoverOnExceed: workflow.takeover_on_exceed ?? "leader",
    roleRotation: {
      enabled: workflow.role_rotation?.enabled ?? false,
      intervalMinutes: workflow.role_rotation?.interval_minutes ?? 120,
      maxSwitches: workflow.role_rotation?.max_switches ?? 2,
    },
    passCondition: workflow.pass_condition ?? null,
    failCondition: workflow.fail_condition ?? null,
  };
}

function normalizeAgents(agents) {
  const result = {};
  for (const [id, entry] of Object.entries(agents ?? {})) {
    if (!isPlainObject(entry)) {
      continue;
    }
    result[id] = {
      kind: entry.kind ?? null,
      command: entry.command ?? null,
      elevatedArgs: Array.isArray(entry.elevated_args) ? [...entry.elevated_args] : [],
      elevatedEnabled: entry.elevated_enabled ?? true,
      model: entry.model ?? null,
      modelArgs: Array.isArray(entry.model_args) ? [...entry.model_args] : [],
      defaultRole: entry.default_role ?? null,
      superpowers: entry.superpowers ?? "unknown",
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `用法：
  node config-tool.mjs validate --scope global|project --file <path>
  node config-tool.mjs merge --defaults <path> [--global <path>] [--project <path>] [--workflow <name>]
  node config-tool.mjs update --file <path> --scope global|project --set <json>
  node config-tool.mjs to-json --file <path>`;

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return value;
}

function fail(message) {
  console.error(`CONFIG_INVALID ${message}`);
  process.exit(1);
}

function main() {
  const [, , command, ...rest] = process.argv;
  if (command === "validate") {
    const scope = readArg(rest, "--scope");
    const file = readArg(rest, "--file");
    if (scope === null || file === null) {
      console.error(USAGE);
      process.exit(2);
    }
    let value;
    try {
      value = parseYamlFile(file);
    } catch (error) {
      fail(error.message);
    }
    const errors =
      scope === "global"
        ? validateGlobalConfig(value)
        : scope === "project"
          ? validateProjectConfig(value)
          : [`--scope 必须为 global 或 project，scope=${scope}`];
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`CONFIG_INVALID ${error}`);
      }
      process.exit(1);
    }
    console.log(JSON.stringify({ scope, valid: true, file }));
    return;
  }
  if (command === "update") {
    // 结构化写回：只更新 --set 中的明确字段路径，保留其余字段，校验通过后原子替换。
    const file = readArg(rest, "--file");
    const scope = readArg(rest, "--scope");
    const setJson = readArg(rest, "--set");
    if (file === null || scope === null || setJson === null) {
      console.error(USAGE);
      process.exit(2);
    }
    let updates;
    try {
      updates = JSON.parse(setJson);
    } catch (error) {
      fail(`--set 必须是合法 JSON 对象，error=${error.message}`);
    }
    if (!isPlainObject(updates)) {
      fail("--set 必须是合法 JSON 对象");
    }
    const result = updateConfigFile(file, updates, scope);
    if (!result.updated) {
      for (const error of result.errors) {
        console.error(`CONFIG_INVALID ${error}`);
      }
      process.exit(1);
    }
    console.log(JSON.stringify({ updated: true, file }));
    return;
  }
  if (command === "to-json") {
    // 供 PowerShell 脚本读取 YAML 的桥接：把任意 YAML 转成 JSON 输出到 stdout。
    const file = readArg(rest, "--file");
    if (file === null) {
      console.error(USAGE);
      process.exit(2);
    }
    try {
      console.log(JSON.stringify(parseYamlFile(file)));
    } catch (error) {
      fail(error.message);
    }
    return;
  }
  if (command === "merge") {
    const defaultsPath = readArg(rest, "--defaults");
    const globalPath = readArg(rest, "--global");
    const projectPath = readArg(rest, "--project");
    const workflowName = readArg(rest, "--workflow");
    if (defaultsPath === null) {
      console.error(USAGE);
      process.exit(2);
    }
    let defaults;
    let globalConfig;
    let projectConfig;
    try {
      defaults = parseYamlFile(defaultsPath);
      globalConfig = globalPath === null ? {} : parseYamlFile(globalPath);
      projectConfig = projectPath === null ? {} : parseYamlFile(projectPath);
    } catch (error) {
      fail(error.message);
    }
    const runtime = workflowName === null ? {} : { workflow: workflowName };
    try {
      const merged = mergeConfig(defaults, globalConfig, projectConfig, runtime);
      console.log(JSON.stringify(merged, null, 2));
    } catch (error) {
      fail(`合并失败，error=${error.message}`);
    }
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 仅作为 CLI 入口直接执行时运行 main()；被测试或其他模块 import 时不执行。
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
