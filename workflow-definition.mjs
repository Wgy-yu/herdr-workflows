import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseYamlFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";

const TEMPLATE_NAMES = new Set(["development", "frontend-backend", "review-only"]);
const MAX_REWORK = 5;
const FORBIDDEN_EXECUTION_FIELDS = new Set(["command", "commands", "script", "shell", "exec"]);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasDuplicate(values) {
  return new Set(values).size !== values.length;
}

function normalizeWritablePath(path) {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function writablePathError(path) {
  const slashPath = path.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    return "writable_paths 不得使用绝对路径";
  }
  if (slashPath.split("/").includes("..")) {
    return "writable_paths 不得包含 .. 路径段";
  }
  return null;
}

function walkForExecutionFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForExecutionFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_EXECUTION_FIELDS.has(key)) {
      errors.push(`${childPath} 不允许在工作流 YAML 中执行命令`);
    }
    walkForExecutionFields(child, childPath, errors);
  }
}

function patternsOverlap(first, second) {
  if (first === second) return true;
  const literalPrefix = (pattern) => {
    const wildcardIndex = pattern.search(/[*!?[\]]/);
    return wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  };
  const firstPrefix = literalPrefix(first);
  const secondPrefix = literalPrefix(second);
  return firstPrefix.startsWith(secondPrefix) || secondPrefix.startsWith(firstPrefix);
}

function phasePairsThatRunInParallel(phases) {
  const byNeeds = new Map();
  for (const phase of phases) {
    const needs = Array.isArray(phase.needs) ? [...phase.needs].sort().join("\u0000") : null;
    if (needs === null) continue;
    const siblings = byNeeds.get(needs) ?? [];
    siblings.push(phase);
    byNeeds.set(needs, siblings);
  }
  const pairs = [];
  for (const siblings of byNeeds.values()) {
    for (let left = 0; left < siblings.length; left++) {
      for (let right = left + 1; right < siblings.length; right++) {
        pairs.push([siblings[left], siblings[right]]);
      }
    }
  }
  return pairs;
}

function findCycle(phaseById) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const phase = phaseById.get(id);
    for (const dependency of Array.isArray(phase?.needs) ? phase.needs : []) {
      if (phaseById.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...phaseById.keys()].some(visit);
}

function findDecisionReachabilityErrors(phases, decision) {
  const successors = new Map(
    phases.filter(isRecord).filter((phase) => isNonEmptyString(phase.id)).map((phase) => [phase.id, []])
  );
  for (const phase of phases) {
    if (!isRecord(phase) || !isNonEmptyString(phase.id) || !Array.isArray(phase.needs)) continue;
    for (const dependency of phase.needs) {
      successors.get(dependency)?.push(phase.id);
    }
  }
  const errors = [];
  const sinks = [...successors.entries()].filter(([, next]) => next.length === 0).map(([id]) => id);
  if (sinks.length !== 1 || sinks[0] !== decision.id) {
    errors.push("decision 必须是唯一 sink 阶段");
  }
  const reachable = new Set([decision.id]);
  const pending = Array.isArray(decision.needs) ? [...decision.needs] : [];
  while (pending.length > 0) {
    const phaseId = pending.pop();
    if (reachable.has(phaseId)) continue;
    reachable.add(phaseId);
    const phase = phases.find((candidate) => isRecord(candidate) && candidate.id === phaseId);
    if (Array.isArray(phase?.needs)) pending.push(...phase.needs);
  }
  for (const phaseId of successors.keys()) {
    if (!reachable.has(phaseId)) errors.push(`phase 无法到达 decision，phase=${phaseId}`);
  }
  return errors;
}

/**
 * Validate a declarative workflow definition. The returned errors are suitable
 * for displaying before a single shared do/goal contract is allowed to start.
 */
export function validateWorkflowDefinition(definition) {
  const errors = [];
  if (!isRecord(definition)) return ["工作流定义必须是对象"];

  walkForExecutionFields(definition, "$", errors);
  if (definition.version !== 1) errors.push("version 必须为 1");
  for (const key of ["workflow_id", "template"]) {
    if (!isNonEmptyString(definition[key])) errors.push(`${key} 必须是非空字符串`);
  }
  if (!Number.isInteger(definition.max_rework) || definition.max_rework < 0 || definition.max_rework > MAX_REWORK) {
    errors.push(`max_rework 必须是 0 到 ${MAX_REWORK} 的整数`);
  }

  const roles = definition.roles;
  if (!isRecord(roles) || Object.keys(roles).length === 0) {
    errors.push("roles 必须是非空对象");
  } else {
    for (const [roleId, role] of Object.entries(roles)) {
      if (!isRecord(role)) {
        errors.push(`角色必须是对象，role=${roleId}`);
        continue;
      }
      if (!isNonEmptyString(role.kind)) errors.push(`角色缺少 kind，role=${roleId}`);
      if (!Array.isArray(role.writable_paths) || role.writable_paths.some((path) => !isNonEmptyString(path))) {
        errors.push(`writable_paths 必须是字符串数组，role=${roleId}`);
      } else {
        for (const path of role.writable_paths) {
          const pathError = writablePathError(path);
          if (pathError) errors.push(`${pathError}，role=${roleId}，path=${path}`);
        }
      }
      if (role.kind === "reviewer" && role.read_only !== true) {
        errors.push(`Reviewer 必须只读，role=${roleId}`);
      }
      if (role.kind === "reviewer" && Array.isArray(role.writable_paths) && role.writable_paths.length > 0) {
        errors.push(`Reviewer 不得拥有业务写路径，role=${roleId}`);
      }
    }
  }

  const phases = definition.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    errors.push("phases 必须是非空数组");
    return errors;
  }
  const phaseIds = phases.map((phase) => (isRecord(phase) ? phase.id : null));
  if (phaseIds.some((id) => !isNonEmptyString(id))) errors.push("phase id 必须是非空字符串");
  if (phaseIds.every(isNonEmptyString) && hasDuplicate(phaseIds)) errors.push("phase id 必须唯一");
  const phaseById = new Map(phases.filter(isRecord).filter((phase) => isNonEmptyString(phase.id)).map((phase) => [phase.id, phase]));

  for (const phase of phases) {
    if (!isRecord(phase)) {
      errors.push("phase 必须是对象");
      continue;
    }
    const phaseId = isNonEmptyString(phase.id) ? phase.id : "<unknown>";
    if (!isNonEmptyString(phase.role) || !isRecord(roles) || !isRecord(roles[phase.role])) {
      errors.push(`phase 使用未知角色，phase=${phaseId}`);
    }
    if (!isNonEmptyString(phase.kind)) errors.push(`phase 缺少 kind，phase=${phaseId}`);
    if (!Array.isArray(phase.needs) || phase.needs.some((need) => !isNonEmptyString(need))) {
      errors.push(`needs 必须是字符串数组，phase=${phaseId}`);
    } else {
      if (hasDuplicate(phase.needs)) errors.push(`needs 不得重复，phase=${phaseId}`);
      for (const need of phase.needs) {
        if (!phaseById.has(need)) errors.push(`phase 依赖未知阶段，phase=${phaseId}，need=${need}`);
      }
      if (phase.needs.length > 1 && phase.join !== true) {
        errors.push(`多依赖阶段必须显式声明 join=true，phase=${phaseId}`);
      }
    }
    if (phase.kind === "implementation" && (!Array.isArray(phase.required_tests) || phase.required_tests.length === 0 || phase.required_tests.some((test) => !isNonEmptyString(test)))) {
      errors.push(`实施阶段必须声明非空 required_tests，phase=${phaseId}`);
    }
    if (phase.kind === "implementation" && (!Array.isArray(roles?.[phase.role]?.writable_paths) || roles[phase.role].writable_paths.length === 0)) {
      errors.push(`实施阶段角色必须拥有非空 writable_paths，phase=${phaseId}`);
    }
    if (phase.kind === "review" || phase.kind === "verification") {
      const role = roles?.[phase.role];
      if (role?.kind !== "reviewer" || role.read_only !== true || !Array.isArray(role.writable_paths) || role.writable_paths.length > 0) {
        errors.push(`review 或 verification 阶段必须绑定只读 Reviewer，phase=${phaseId}`);
      }
    }
    if (!isRecord(phase.callback) || !isNonEmptyString(phase.callback.type) || !Array.isArray(phase.callback.required_fields) || phase.callback.required_fields.length === 0 || phase.callback.required_fields.some((field) => !isNonEmptyString(field))) {
      errors.push(`phase 必须声明结构化 callback，phase=${phaseId}`);
    }
  }

  if (findCycle(phaseById)) errors.push("phase needs 必须是无环图");

  if (isRecord(roles)) {
    for (const [first, second] of phasePairsThatRunInParallel(phases.filter(isRecord))) {
      if (first.role === second.role) continue;
      const firstPaths = roles[first.role]?.writable_paths?.map(normalizeWritablePath);
      const secondPaths = roles[second.role]?.writable_paths?.map(normalizeWritablePath);
      if (!Array.isArray(firstPaths) || !Array.isArray(secondPaths)) continue;
      if (firstPaths.some((firstPath) => secondPaths.some((secondPath) => patternsOverlap(firstPath, secondPath)))) {
        errors.push(`并行写路径重叠，roles=${first.role},${second.role}`);
      }
    }
  }

  const decisions = phases.filter((phase) => isRecord(phase) && phase.kind === "decision");
  if (decisions.length !== 1) {
    errors.push("必须且只能有一个最终 Leader decision 阶段");
  } else {
    const [decision] = decisions;
    const hasSuccessor = phases.some((phase) => isRecord(phase) && Array.isArray(phase.needs) && phase.needs.includes(decision.id));
    if (decision.role !== "leader" || decision.protected !== true || hasSuccessor) {
      errors.push("最终 decision 必须是受保护的 Leader 终止阶段");
    }
    errors.push(...findDecisionReachabilityErrors(phases, decision));
  }
  return errors;
}

export function compileWorkflowDefinition(definition, overrides = {}) {
  const errors = validateWorkflowDefinition(definition);
  if (errors.length > 0) throw new Error(`工作流定义无效：${errors.join("；")}`);
  const agentOverrides = isRecord(overrides.agents) ? overrides.agents : {};
  const roles = Object.fromEntries(Object.entries(definition.roles).map(([roleId, role]) => [roleId, {
    agent: agentOverrides[roleId] ?? role.agent ?? null,
    kind: role.kind,
    readOnly: role.read_only === true,
    writablePaths: role.writable_paths.map(normalizeWritablePath),
  }]));
  const phases = Object.fromEntries(definition.phases.map((phase) => [phase.id, {
    role: phase.role,
    kind: phase.kind,
    needs: [...phase.needs],
    join: phase.join === true,
    requiredTests: Array.isArray(phase.required_tests) ? [...phase.required_tests] : [],
    protected: phase.protected === true,
    callback: {
      type: phase.callback.type,
      requiredFields: [...phase.callback.required_fields],
    },
  }]));
  const finalPhase = definition.phases.find((phase) => phase.kind === "decision");
  return {
    version: 1,
    workflowId: definition.workflow_id,
    template: definition.template,
    roles,
    phases,
    finalPhaseId: finalPhase.id,
    maxAutoHops: 8,
    maxRework: definition.max_rework,
    compiledAt: new Date().toISOString(),
  };
}

export function loadBuiltInTemplate(name) {
  if (!TEMPLATE_NAMES.has(name)) throw new Error(`未知内置工作流模板，name=${name}`);
  const definition = parseYamlFile(join(moduleDirectory, "skills", "herdr-workflows", "assets", "templates", `${name}.yaml`));
  return structuredClone(definition);
}
