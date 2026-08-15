import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requestSocket } from "./herdr-event-bridge.mjs";
import { updateConfigFile } from "./skills/herdr-workflows/scripts/config-tool.mjs";

const ACTION_TEMPLATES = {
  init: "development",
  "init-development": "development",
  "init-frontend-backend": "frontend-backend",
  "init-review-only": "review-only",
};

const roleNames = {
  development: ["leader", "implementer", "reviewer"],
  "frontend-backend": ["leader", "frontend", "backend", "reviewer"],
  "review-only": ["leader", "reviewer"],
};

const normalizedAgents = (response, workspaceId) => {
  const result = response?.result ?? response;
  const agents = Array.isArray(result) ? result : result?.agents ?? [];
  return agents.filter((agent) => !workspaceId || (agent.workspace_id ?? agent.workspaceId) === workspaceId);
};

const identity = (agent) => String(agent.name ?? agent.agent_name ?? agent.id ?? agent.pane_id ?? "");
const kind = (agent) => String(agent.kind ?? agent.agent_kind ?? identity(agent)).toLowerCase();

export function selectTemplateAgents(template, agents, context = {}) {
  const available = [...agents];
  const take = (predicate) => {
    const index = available.findIndex(predicate);
    if (index < 0) return null;
    return identity(available.splice(index, 1)[0]);
  };
  const focusedPane = context.focused_pane_id ?? context.pane_id;
  const leader = take((agent) => focusedPane && (agent.pane_id ?? agent.paneId) === focusedPane)
    ?? take((agent) => kind(agent).includes("codex"))
    ?? take(() => true);
  const reviewer = take((agent) => kind(agent).includes("claude")) ?? take(() => true);
  const selected = { leader };
  if (template === "development") selected.implementer = take((agent) => kind(agent).includes("opencode")) ?? take(() => true);
  if (template === "frontend-backend") {
    selected.frontend = take((agent) => kind(agent).includes("opencode")) ?? take(() => true);
    selected.backend = take((agent) => kind(agent).includes("opencode")) ?? take(() => true);
  }
  selected.reviewer = reviewer;
  return selected;
}

export async function initializeProject({ projectRoot, actionId = "init", context = {}, request }) {
  const template = ACTION_TEMPLATES[actionId];
  if (!template) throw new Error(`未知初始化 Action：${actionId}`);
  const workspaceId = context.workspace_id ?? context.workspaceId;
  const agents = normalizedAgents(await request("agent.list", {}), workspaceId);
  const selected = selectTemplateAgents(template, agents, context);
  const missing = roleNames[template].filter((role) => !selected[role]);
  if (missing.length) {
    return { status: "INIT_INPUT_REQUIRED", template, missing_roles: missing, available_agents: agents.map(identity).filter(Boolean) };
  }

  const name = template;
  const updates = {
    default_workflow: name,
    [`workflows.${name}.template`]: template,
    [`workflows.${name}.use_superpowers`]: true,
    [`workflows.${name}.max_rework`]: 5,
    [`workflows.${name}.event_bridge_required`]: true,
    [`workflows.${name}.structured_callbacks_required`]: true,
    [`workflows.${name}.scope_checks_required`]: true,
    [`workflows.${name}.final_decision_required`]: true,
  };
  for (const [role, agent] of Object.entries(selected)) updates[`workflows.${name}.roles.${role}.agent`] = agent;
  const file = join(resolve(projectRoot), ".herdr", "workflows.yaml");
  mkdirSync(join(resolve(projectRoot), ".herdr"), { recursive: true });
  updateConfigFile(file, updates, "project");
  return { status: "INIT_READY", template, workflow: name, config_path: file, roles: selected };
}

async function main(env = process.env) {
  const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  const projectRoot = context.workspace_cwd ?? context.focused_pane_cwd ?? process.cwd();
  return initializeProject({
    projectRoot,
    actionId: env.HERDR_PLUGIN_ACTION_ID ?? "init",
    context,
    request: (method, params) => requestSocket(env.HERDR_SOCKET_PATH, method, params),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((value) => console.log(JSON.stringify(value))).catch((error) => {
    console.error(`HERDR_WORKFLOWS_INIT_ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
