function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
function statusOf(response) { return response?.result?.agent?.status ?? response?.result?.status ?? response?.status ?? "unknown"; }

export async function startAgentTurn({ target, text, timeoutMs = 120_000 }, request) {
  const deadline = Date.now() + timeoutMs;
  const before = statusOf(await request("agent.get", { target, timeout: remaining(deadline) }));
  if (before === "working") return { status: "DELIVERY_UNKNOWN", reason: "already-working" };
  try {
    const response = await request("agent.prompt", { target, text, wait: true, until: ["working"], timeout: remaining(deadline) });
    const after = statusOf(response);
    if (after === "blocked") return { status: "BLOCKED" };
    if (after === "working" || response?.result?.ok === true) return { status: "TURN_STARTED" };
    return { status: "DELIVERY_UNKNOWN" };
  } catch (error) {
    return { status: "DELIVERY_UNKNOWN", error: error.message };
  }
}

export function selectExecutionAdapter(capabilities = {}, mode = "do") {
  if (mode === "goal" && capabilities.goal === true) return { kind: "goal", fallback: false };
  return { kind: "turn", fallback: mode === "goal" };
}
