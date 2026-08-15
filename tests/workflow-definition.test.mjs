import test from "node:test";
import assert from "node:assert/strict";
import {
  compileWorkflowDefinition,
  loadBuiltInTemplate,
  validateWorkflowDefinition,
} from "../workflow-definition.mjs";

test("frontend-backend compiles parallel implementers into an explicit join", () => {
  const contract = compileWorkflowDefinition(loadBuiltInTemplate("frontend-backend"), {
    agents: { leader: "codex", frontend: "claude", backend: "opencode", reviewer: "pi" },
  });
  assert.deepEqual(contract.phases.integration_review.needs.sort(), ["backend_implement", "frontend_implement"]);
  assert.equal(contract.roles.reviewer.readOnly, true);
  assert.equal(contract.maxAutoHops, 8);
});

test("custom definitions cannot overlap parallel write scopes", () => {
  const definition = loadBuiltInTemplate("frontend-backend");
  definition.roles.frontend.writable_paths = ["src/**"];
  definition.roles.backend.writable_paths = ["src/**"];
  assert.throws(() => compileWorkflowDefinition(definition), /并行写路径重叠/);
});

test("parallel literal write paths remain independent", () => {
  const definition = loadBuiltInTemplate("frontend-backend");
  definition.roles.frontend.writable_paths = ["src/shared-a"];
  definition.roles.backend.writable_paths = ["src/shared-b"];
  assert.doesNotThrow(() => compileWorkflowDefinition(definition));
});

test("all built-in templates end at a protected Leader decision", () => {
  for (const name of ["development", "frontend-backend", "review-only"]) {
    const contract = compileWorkflowDefinition(loadBuiltInTemplate(name));
    assert.equal(contract.template, name);
    assert.equal(contract.finalPhaseId, "decision");
    assert.equal(contract.phases.decision.role, "leader");
    assert.equal(contract.phases.decision.protected, true);
  }
});

test("every phase must converge on the sole decision sink", () => {
  const definition = loadBuiltInTemplate("development");
  definition.phases.push({
    id: "unmerged_branch",
    role: "leader",
    kind: "design",
    needs: ["design"],
    callback: { type: "plan", required_fields: ["plan_path"] },
  });
  assert.throws(() => compileWorkflowDefinition(definition), /唯一 sink|无法到达 decision/);
});

test("write paths normalize separators and reject absolute or traversal paths", () => {
  const normalized = loadBuiltInTemplate("frontend-backend");
  normalized.roles.frontend.writable_paths = ["src\\frontend\\**"];
  assert.deepEqual(
    compileWorkflowDefinition(normalized).roles.frontend.writablePaths,
    ["src/frontend/**"]
  );

  const absolute = loadBuiltInTemplate("frontend-backend");
  absolute.roles.frontend.writable_paths = ["C:\\workspace\\src\\frontend\\**"];
  assert.throws(() => compileWorkflowDefinition(absolute), /绝对路径/);

  const traversal = loadBuiltInTemplate("frontend-backend");
  traversal.roles.frontend.writable_paths = ["src\\frontend\\..\\shared\\**"];
  assert.throws(() => compileWorkflowDefinition(traversal), /\.\./);

  const overlapping = loadBuiltInTemplate("frontend-backend");
  overlapping.roles.frontend.writable_paths = ["src\\shared\\**"];
  overlapping.roles.backend.writable_paths = ["src/shared/**"];
  assert.throws(() => compileWorkflowDefinition(overlapping), /并行写路径重叠/);
});

test("implementation phases require a role with writable paths", () => {
  const definition = loadBuiltInTemplate("development");
  definition.roles.implementer.writable_paths = [];
  assert.throws(() => compileWorkflowDefinition(definition), /实施阶段角色必须拥有非空 writable_paths/);
});

test("review and verification phases require a read-only reviewer role", () => {
  for (const phaseId of ["review", "verify"]) {
    const definition = loadBuiltInTemplate("development");
    definition.phases.find((phase) => phase.id === phaseId).role = "implementer";
    assert.throws(
      () => compileWorkflowDefinition(definition),
      /review 或 verification 阶段必须绑定只读 Reviewer/
    );
  }
});

test("malformed decision needs returns validation errors instead of throwing", () => {
  for (const malformedNeeds of [undefined, "verify", 1, { phase: "verify" }]) {
    const definition = loadBuiltInTemplate("development");
    definition.phases.find((phase) => phase.id === "decision").needs = malformedNeeds;
    assert.doesNotThrow(() => validateWorkflowDefinition(definition));
    assert.match(validateWorkflowDefinition(definition).join("\n"), /needs 必须是字符串数组/);
  }
});

test("validator rejects unsafe and non-deterministic workflow definitions", () => {
  const definition = loadBuiltInTemplate("development");
  definition.max_rework = 6;
  definition.roles.reviewer.read_only = false;
  definition.roles.reviewer.command = "npm test";
  definition.phases[1].role = "missing";
  definition.phases[1].needs = ["missing", "review"];
  definition.phases[1].required_tests = [];
  definition.phases[1].callback = { type: "", required_fields: [] };
  definition.phases[2].needs = ["implement", "design"];
  definition.phases[2].join = false;
  definition.phases[3].id = "implement";
  definition.phases[5].protected = false;

  const errors = validateWorkflowDefinition(definition);
  assert.match(errors.join("\n"), /max_rework/);
  assert.match(errors.join("\n"), /Reviewer 必须只读/);
  assert.match(errors.join("\n"), /执行命令/);
  assert.match(errors.join("\n"), /未知角色/);
  assert.match(errors.join("\n"), /依赖未知阶段/);
  assert.match(errors.join("\n"), /无环图/);
  assert.match(errors.join("\n"), /显式声明 join/);
  assert.match(errors.join("\n"), /required_tests/);
  assert.match(errors.join("\n"), /结构化 callback/);
  assert.match(errors.join("\n"), /phase id 必须唯一/);
  assert.match(errors.join("\n"), /最终 decision 必须是受保护/);
});
