// Compatibility surface for callers that imported workflow-state.mjs.
// All persistence is owned by the native .herdr/workflow store.
export { applyStoredEvent, readStoredWorkflow as readWorkflowState, startStoredWorkflow as startWorkflow, withWorkflowLock } from "./workflow-store.mjs";
