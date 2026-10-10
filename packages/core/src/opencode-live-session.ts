// opencode live sessions: the opencode TurnAdapter for the shared per-turn engine
// (turn-live-session.ts) — one `opencode run [--session <id>]` spawn per turn, all in the same
// session. Same `--auto` permissions bypass as opencode delegate runs. See
// .memory/project-live-sessions.md.

import { opencodeResult, opencodeRunArgs, opencodeTailLine } from "./delegate.js";
import { isOpencodeSessionId } from "./delegate-runs.js";
import { killTree } from "./kill-tree.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest, LiveSessionSpawnFn } from "./live-session.js";
import { startTurnLiveSession, type TurnAdapter, type TurnEvent } from "./turn-live-session.js";

export const OPENCODE_SIGNED_OUT =
  "opencode couldn't authenticate with its model provider on the host — check `opencode auth list` on that Mac.";
export const OPENCODE_SESSION_MISMATCH = "Couldn't reopen that session — opencode answered from a different one, which was stopped.";

/** The chat-safe reason for an opencode `error` event: only its `name` and `statusCode` —
 * `data.message` can echo an API-key prefix or a path, so it never reaches chat. */
export function opencodeFailure(error: unknown): string {
  const e = error as { name?: unknown; data?: { statusCode?: unknown } } | null;
  const name = typeof e?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "error";
  const status = e?.data?.statusCode;
  if (status === 401 || status === 403) return OPENCODE_SIGNED_OUT;
  if (typeof status === "number") return `opencode couldn't run that turn (${name} ${status}).`;
  return `opencode couldn't run that turn (${name}) — check the model's provider login on the host (\`opencode auth list\`).`;
}

function parseOpencode(event: unknown): TurnEvent {
  const e = event as { type?: unknown; sessionID?: unknown; error?: unknown; part?: { reason?: unknown } } | null;
  // An error event carries a sessionID too, but it doesn't prove the turn ran.
  if (e?.type === "error") return { failure: opencodeFailure(e.error) };
  return {
    ...(typeof e?.sessionID === "string" && e.sessionID ? { sessionId: e.sessionID } : {}),
    // A step ending "tool-calls" is followed by another; "stop" ends the turn.
    ...(e?.type === "step_finish" && e.part?.reason === "stop" ? { completed: true } : {}),
    result: opencodeResult(event),
    tail: opencodeTailLine(event),
  };
}

export const opencodeTurnAdapter: TurnAdapter = {
  command: "opencode",
  args: opencodeRunArgs,
  validResume: isOpencodeSessionId,
  parse: parseOpencode,
  rejected: /Session not found/i,
  mismatch: OPENCODE_SESSION_MISMATCH,
  // opencode reaps its tools on neither SIGTERM nor SIGINT: soft-signal every group (#246).
  stop: (pid) => killTree(pid, "SIGTERM"),
  endMessages: [OPENCODE_SIGNED_OUT, OPENCODE_SESSION_MISMATCH],
};

export function startOpencodeLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn?: LiveSessionSpawnFn,
  idleTimeoutMs?: number,
  now?: () => number,
): LiveSessionHandle {
  return startTurnLiveSession(opencodeTurnAdapter, req, cbs, spawnFn, idleTimeoutMs, now);
}
