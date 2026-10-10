// Codex live sessions: the codex TurnAdapter for the shared per-turn engine (turn-live-session.ts)
// — one `codex exec [resume <thread>]` spawn per turn, all in the same thread. Same permissions
// bypass as codex delegate runs. See .memory/project-live-sessions.md.

import { codexExecArgs, codexResult, codexTailLine } from "./delegate.js";
import { isCodexSessionId } from "./delegate-runs.js";
import { signalGroups, treeGroups } from "./kill-tree.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest, LiveSessionSpawnFn } from "./live-session.js";
import { startTurnLiveSession, type TurnAdapter, type TurnEvent } from "./turn-live-session.js";

export const CODEX_SIGNED_OUT = "Codex is signed out on the host — someone needs to run `codex login` on that Mac.";
export const CODEX_THREAD_MISMATCH = "Couldn't reopen that session — codex started a different one, which was stopped.";

const AUTH_ERROR = /\b(401|unauthori[sz]ed|not (?:signed|logged) in|codex login)\b/i;

/** One tail line per codex event; a shell command shows as `▸ shell` (no raw argv or paths in chat). */
function codexLiveTail(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown } } | null;
  if (e?.type === "item.completed" && e.item?.type === "command_execution") return "▸ shell";
  return codexTailLine(event);
}

function parseCodex(event: unknown): TurnEvent {
  const e = event as { type?: unknown; thread_id?: unknown; message?: unknown; error?: { message?: unknown } } | null;
  if (e?.type === "thread.started") return typeof e.thread_id === "string" ? { sessionId: e.thread_id } : {};
  if (e?.type === "turn.completed") return { completed: true };
  if (e?.type === "turn.failed") return { failure: typeof e.error?.message === "string" && e.error.message ? e.error.message : "turn failed" };
  if (e?.type === "error") return { failure: typeof e.message === "string" && e.message ? e.message : "error" };
  return { result: codexResult(event), tail: codexLiveTail(event) };
}

export const codexTurnAdapter: TurnAdapter = {
  command: "codex",
  args: codexExecArgs,
  // codex would treat a non-UUID id as a thread name and silently start a new thread.
  validResume: isCodexSessionId,
  parse: parseCodex,
  rejected: /no rollout found/i,
  failureText: (failure, stderr) => (AUTH_ERROR.test(`${failure ?? ""}\n${stderr}`) ? CODEX_SIGNED_OUT : undefined),
  mismatch: CODEX_THREAD_MISMATCH,
  // SIGINT to codex's own group only: codex runs tool commands in their own groups and reaps
  // them on SIGINT (SIGTERM/SIGKILL orphan them, #237); the tree is the SIGKILL backstop.
  stop: (pid) => {
    const groups = treeGroups(pid);
    signalGroups([pid], "SIGINT");
    return groups;
  },
  endMessages: [CODEX_SIGNED_OUT, CODEX_THREAD_MISMATCH],
};

export function startCodexLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn?: LiveSessionSpawnFn,
  idleTimeoutMs?: number,
  now?: () => number,
): LiveSessionHandle {
  return startTurnLiveSession(codexTurnAdapter, req, cbs, spawnFn, idleTimeoutMs, now);
}
