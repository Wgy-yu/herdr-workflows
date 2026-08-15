import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const hashCallbackToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");

export function createDispatchEnvelope(state, phaseId, contract) {
  const phase = state.phases[phaseId];
  const definition = contract.phases[phaseId];
  if (!phase || phase.status !== "READY") throw new Error("PHASE_NOT_READY");
  const callbackToken = randomBytes(32).toString("base64url");
  return {
    workflowId: state.workflowId, runId: state.runId, phaseId, attempt: phase.attempt,
    role: definition.role, eventId: randomUUID(), callbackType: definition.callback.type,
    requiredFields: [...definition.callback.requiredFields],
    callbackToken, callbackTokenHash: hashCallbackToken(callbackToken),
    contractPath: ".herdr/workflow/contract.json",
    requestPath: ".herdr/workflow/request.md",
    callbackRequestPath: `.herdr/workflow/callbacks/${phaseId}-attempt-${phase.attempt}.json`,
  };
}

function equalHash(first, second) {
  if (typeof first !== "string" || typeof second !== "string" || first.length !== second.length) return false;
  return timingSafeEqual(Buffer.from(first), Buffer.from(second));
}

export function validateCallbackEnvelope(envelope, state, contract) {
  if (!envelope || envelope.workflow_id !== state.workflowId || envelope.run_id !== state.runId) return { valid: false, error: "CALLBACK_WORKFLOW_INVALID" };
  const phase = state.phases[envelope.phase_id];
  const definition = contract.phases[envelope.phase_id];
  if (!phase || !definition || envelope.attempt !== phase.attempt || envelope.role !== definition.role) return { valid: false, error: "CALLBACK_CORRELATION_INVALID" };
  if (envelope.in_reply_to !== phase.dispatchedEventId) return { valid: false, error: "CALLBACK_CAUSATION_INVALID" };
  if (envelope.type !== definition.callback.type && !(definition.kind === "decision" && envelope.type === "FINAL_DECISION")) return { valid: false, error: "CALLBACK_TYPE_INVALID" };
  const actual = hashCallbackToken(envelope.callback_token ?? "");
  if (!equalHash(actual, phase.callbackTokenHash)) return { valid: false, error: "CALLBACK_TOKEN_INVALID" };
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  if (definition.callback.requiredFields.some((field) => !(field in payload))) return { valid: false, error: "CALLBACK_FIELDS_MISSING" };
  const changed = Array.isArray(payload.changed_files) ? payload.changed_files.map((path) => path.replaceAll("\\", "/")) : [];
  if (["review", "verification"].includes(definition.kind) && changed.length > 0) return { valid: false, error: "REVIEWER_WRITE_FORBIDDEN" };
  if (definition.kind === "implementation") {
    const scopes = contract.roles[definition.role].writablePaths;
    const within = (path, pattern) => { const prefix = pattern.split(/[*!?[\]]/, 1)[0]; return path === prefix.replace(/\/$/, "") || path.startsWith(prefix); };
    if (changed.some((path) => path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..") || !scopes.some((scope) => within(path, scope)))) return { valid: false, error: "WRITE_SCOPE_VIOLATION" };
  }
  return { valid: true, callbackTokenHash: actual };
}

export function formatDispatchMessage(envelope) {
  return [
    "完成阶段后必须调用 Herdr workflow callback Action。",
    `workflow_id=${envelope.workflowId}`, `run_id=${envelope.runId}`, `phase_id=${envelope.phaseId}`,
    `attempt=${envelope.attempt}`, `role=${envelope.role}`, `in_reply_to=${envelope.eventId}`,
    `callback_type=${envelope.callbackType}`, `callback_token=${envelope.callbackToken}`,
    `payload_required_fields=${envelope.requiredFields.join(",")}`,
    `contract_path=${envelope.contractPath}`,
    `request_path=${envelope.requestPath}`,
    `callback_request_path=${envelope.callbackRequestPath}`,
    "将结构化字段、payload 和 report_markdown 写入 callback_request_path，然后执行：herdr plugin action invoke wgy.herdr-workflows-bridge.callback",
  ].join("\n");
}
