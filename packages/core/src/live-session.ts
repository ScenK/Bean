// Multi-turn interactive counterpart to delegate.ts's one-shot runDelegate: a long-lived
// `claude -p` process fed user turns over stdin (stream-json), streaming events back on
// stdout, driven remotely from a chatops channel. Spec: docs/superpowers/specs/
// 2026-07-18-live-sessions-design.md — permissions are deliberately bypassed (true bypass).

export interface LiveSessionRequest {
  projectPath: string;
  /** The opening instruction — written to stdin as the first user turn. */
  prompt: string;
  /** Literal --model value (clis.json); flag omitted when unset. */
  model?: string;
}

export function liveSessionCommand(req: LiveSessionRequest): { command: string; args: string[] } {
  const modelArgs = req.model ? ["--model", req.model] : [];
  return {
    command: "claude",
    args: [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      ...modelArgs,
    ],
  };
}

/** One stdin line = one user turn, per claude's stream-json input protocol. */
export function userTurnLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

/** Per-turn completion event — claude emits one `result` event at the end of every turn. */
export interface TurnSummary {
  result: string;
  durationMs?: number;
  costUsd?: number;
}

export function claudeTurnSummary(event: unknown): TurnSummary | undefined {
  const e = event as { type?: unknown; result?: unknown; duration_ms?: unknown; total_cost_usd?: unknown } | null;
  if (e?.type !== "result") return undefined;
  return {
    result: typeof e.result === "string" ? e.result : "",
    durationMs: typeof e.duration_ms === "number" ? e.duration_ms : undefined,
    costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
  };
}
