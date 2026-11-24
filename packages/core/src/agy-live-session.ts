// agy (Antigravity CLI) live sessions: the agy TurnAdapter for the shared per-turn engine
// (turn-live-session.ts) — one `agy -p=<prompt> [--conversation <uuid>]` spawn per turn, all in the
// same conversation. Same permissions bypass and stream parsing as agy delegate runs. See
// .memory/safety-agy-delegate.md and .memory/project-live-sessions.md.

import { AGY_SIGNED_OUT, agyError, agyPrintArgs, agyResult, agyStream } from "./delegate.js";
import { isCodexSessionId } from "./delegate-runs.js";
import { killTree } from "./kill-tree.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest, LiveSessionSpawnFn } from "./live-session.js";
import { startTurnLiveSession, type TurnAdapter, type TurnEvent } from "./turn-live-session.js";

export const AGY_CONVERSATION_MISMATCH = "Couldn't reopen that session — agy started a different one, which was stopped.";

const AUTH_ERROR = /authentication failed or timed out/i;

/** One turn's parser: `init` → session id, `result` → completed (SUCCESS) or failure (ERROR), and
 * agyStream's `▸ <tool_name>` tails plus one prose text per agent_response step on DONE. */
function agyParser(): (event: unknown) => TurnEvent {
  const step = agyStream();
  return (event) => {
    const e = event as { event?: unknown; conversation_id?: unknown; result?: { status?: unknown } } | null;
    if (e?.event === "init") return typeof e.conversation_id === "string" && e.conversation_id ? { sessionId: e.conversation_id } : {};
    if (e?.event === "result") {
      const failure = agyError(event);
      return failure !== undefined ? { failure } : { result: agyResult(event), ...(e.result?.status === "SUCCESS" ? { completed: true } : {}) };
    }
    return step(event);
  };
}

export const agyTurnAdapter: TurnAdapter = {
  command: "agy",
  args: agyPrintArgs,
  // agy takes a conversation id only as a UUID.
  validResume: isCodexSessionId,
  parser: agyParser,
  // agy never rejects an unknown id: it starts fresh, and the engine's mismatch path stops that.
  rejected: /(?!)/,
  // Signed out, agy's stderr carries the OAuth login URL — the engine never shows stderr in chat.
  failureText: (failure, stderr) => (AUTH_ERROR.test(`${failure ?? ""}\n${stderr}`) ? AGY_SIGNED_OUT : undefined),
  mismatch: AGY_CONVERSATION_MISMATCH,
  // agy 1.5.14 reaps its tool groups on neither SIGINT nor SIGTERM (a `sleep` outlived both), so
  // soft-signal every group of the tree, like opencode; the conversation stays resumable.
  stop: (pid) => killTree(pid, "SIGTERM"),
  endMessages: [AGY_SIGNED_OUT, AGY_CONVERSATION_MISMATCH],
};

export function startAgyLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn?: LiveSessionSpawnFn,
  idleTimeoutMs?: number,
  now?: () => number,
): LiveSessionHandle {
  return startTurnLiveSession(agyTurnAdapter, req, cbs, spawnFn, idleTimeoutMs, now);
}
