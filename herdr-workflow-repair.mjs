import { repairWorkflow } from "./workflow-store.mjs";
import { pathToFileURL } from "node:url";
export function handleRepair(options = {}) { return repairWorkflow(options.projectRoot ?? options.workspace_cwd ?? process.cwd()); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  try { console.log(JSON.stringify(handleRepair({ workspace_cwd: context.workspace_cwd ?? context.focused_pane_cwd }))); }
  catch (error) { console.error(`HERDR_WORKFLOW_REPAIR_ERROR ${error.message}`); process.exitCode = 1; }
}
