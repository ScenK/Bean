// Multi-turn interactive counterpart to delegate.ts's one-shot runDelegate: a long-lived
// `claude -p` process fed user turns over stdin (stream-json), streaming events back on
// stdout, driven remotely from a chatops channel. Permissions are deliberately bypassed (true bypass).

import { spawn, type ChildProcess } from "node:child_process";
import { BEAN_GIT_IDENTITY, GIT_TRAILER_INSTRUCTION, claudeTailLine, sessionIdOf } from "./delegate.js";
import { spawnEnv } from "./spawn-env.js";

/** CLIs that can host a live session, claude first (the default engine): claude (one long-lived
 * stream-json process), codex and opencode (one spawn per turn, turn-live-session.ts). */
export type LiveCli = "claude" | "codex" | "opencode";
export const LIVE_CLIS: readonly LiveCli[] = ["claude", "codex", "opencode"];

export function isLiveCli(cli: unknown): cli is LiveCli {
  return LIVE_CLIS.includes(cli as LiveCli);
}

export interface LiveSessionRequest {
  /** Engine; absent = claude. */
  cli?: LiveCli;
  projectPath: string;
  /** The opening instruction — the first user turn. "" = lazy (Continue live): nothing spawns
   * until the first send(), which becomes the opening turn. */
  prompt: string;
  /** Literal --model value (clis.json); flag omitted when unset. */
  model?: string;
  /** Session id to continue (claude `--resume`, codex `exec resume`, opencode `--session`). Only pass an id Bean recorded in delegate_runs. */
  resume?: string;
}

/** A resumed session the host rejected (expired or removed id) — claude exits before
 * `system/init`; nothing ran, so the turn that tried to open it was never answered. */
export const RESUME_REJECTED = "Couldn't reopen that session (expired or removed on the host). Nothing was sent.";

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
      ...(req.resume ? ["--resume", req.resume] : []),
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
  /** Set when the turn failed (per-turn CLIs): the session stays bound, nothing goes to history. */
  failed?: string;
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

export interface LiveSessionCallbacks {
  onOutput: (line: string) => void;
  /** A turn began without a fresh send() (per-turn CLIs: a queued, merged turn) — relight typing. */
  onTurnStart?: () => void;
  onTurnComplete: (summary: TurnSummary) => void;
  /** The CLI's own session id, once per engine: after the event that proves the session started,
   * and on a resume only when it matches the resumed id. A throw is swallowed (bookkeeping). */
  onSessionId?: (id: string) => void;
  /** Fires exactly once. undefined = clean end (stop/idle/exit 0); Error = crash. */
  onExit: (err?: Error) => void;
}

export interface LiveSessionHandle {
  /** False when the text was refused (per-turn CLIs: the merged next turn would overflow its cap). */
  send: (text: string) => boolean;
  stop: () => void;
  pid: number | undefined;
}

/** Calls `onSessionId` with a session id, swallowing its errors so bookkeeping can't break a session. */
export function reportSessionId(cbs: LiveSessionCallbacks, id: string): void {
  try {
    cbs.onSessionId?.(id);
  } catch (err) {
    console.warn("bean: live session id callback failed:", err instanceof Error ? err.name : "error");
  }
}

export type LiveSessionSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;

// stdin is "pipe" (delegate uses "ignore") — the whole point is writing further turns.
const defaultLiveSpawn: LiveSessionSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: spawnEnv(BEAN_GIT_IDENTITY) });

export const LIVE_SESSION_IDLE_MS = 30 * 60_000;

export function startLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn: LiveSessionSpawnFn = defaultLiveSpawn,
  idleTimeoutMs: number = LIVE_SESSION_IDLE_MS,
): LiveSessionHandle {
  const { command, args } = liveSessionCommand(req);
  // Unset until the opening turn: a lazy start (prompt "") spawns on the first send().
  let child: ChildProcess | undefined;

  let exited = false;
  let stopping = false;
  // A bad --resume id makes claude emit an error `result` and exit before `system/init`.
  let initSeen = false;
  // Set by a `result`; the next turn's first `system/init` (claude emits one per turn) or
  // `assistant` (fallback) clears it and reports onTurnStart — a queued message answered as its
  // own turn, after the previous `result` already stopped typing.
  let afterResult = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const kill = (c: ChildProcess, signal: NodeJS.Signals): void => {
    try {
      if (typeof c.pid === "number") process.kill(-c.pid, signal);
      else c.kill(signal);
    } catch {
      c.kill(signal);
    }
  };

  const settle = (err?: Error): void => {
    if (exited) return;
    exited = true;
    clearTimeout(idleTimer);
    clearTimeout(killTimer);
    cbs.onExit(err);
  };

  const beginStop = (): void => {
    if (exited || stopping) return;
    stopping = true;
    const c = child;
    if (!c) { settle(); return; } // never spawned: nothing to wait for
    kill(c, "SIGTERM");
    killTimer = setTimeout(() => kill(c, "SIGKILL"), 5_000);
  };

  const resetIdle = (): void => {
    if (exited) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(beginStop, idleTimeoutMs);
  };

  const handleLine = (line: string): void => {
    if (!line.trim() || exited) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      cbs.onOutput(line);
      return;
    }
    const e = event as { type?: unknown; subtype?: unknown } | null;
    if (e?.type === "system" && e.subtype === "init" && !initSeen) {
      initSeen = true;
      const id = sessionIdOf("claude", event);
      if (id && (!req.resume || id === req.resume)) reportSessionId(cbs, id);
    }
    // Pre-init on a resume, a `result` is claude's rejection, not a turn — the exit reports it.
    if (req.resume && !initSeen) return;
    if (afterResult && (e?.type === "assistant" || (e?.type === "system" && e.subtype === "init"))) {
      afterResult = false;
      if (!stopping) cbs.onTurnStart?.();
    }
    const summary = claudeTurnSummary(event);
    if (summary) {
      afterResult = true;
      cbs.onTurnComplete(summary);
      resetIdle();
      return;
    }
    const tail = claudeTailLine(event);
    if (tail) {
      cbs.onOutput(tail);
      resetIdle();
    }
  };

  // Spawns the child and writes the opening turn (with the git trailer instruction).
  const open = (text: string): void => {
    const c = spawnFn(command, args, req.projectPath);
    child = c;
    let stdoutBuf = "";
    c.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
        handleLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    });

    // Must drain stderr even though we only use it for error-reporting context: an unread pipe
    // fills its OS buffer once the child (or a hook/plugin under it) writes enough to it, which
    // then blocks the child on its next write — silently hanging a session that looks "active"
    // (same reasoning as delegate.ts's stderrBuf).
    let stderrBuf = "";
    c.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
    });

    c.on("error", (err: Error) => settle(err));
    c.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      // code === null means a signal killed it — that's the EXPECTED shape of our own
      // stop()/idle-timeout path (SIGTERM, or SIGKILL escalation), but NOT of an external kill
      // (an operator's `kill -9`, an OOM reaper): only `stopping` tells them apart, so check it
      // rather than treating every null code as a clean end.
      if (req.resume && !initSeen && !stopping) { settle(new Error(RESUME_REJECTED)); return; }
      if (stopping || code === 0) { settle(); return; }
      const tail = stderrBuf.trim().split("\n").slice(-5).join("\n");
      const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      settle(new Error(`claude exited with ${reason}${tail ? ` - ${tail}` : ""}`));
    });

    c.stdin?.write(userTurnLine(text + GIT_TRAILER_INSTRUCTION));
  };

  if (req.prompt) open(req.prompt);
  resetIdle();

  return {
    get pid() { return child?.pid; },
    send: (text) => {
      if (exited || stopping) return true;
      if (child) child.stdin?.write(userTurnLine(text));
      else {
        try {
          open(text);
        } catch (err) {
          settle(err instanceof Error ? err : new Error(String(err)));
          return true;
        }
      }
      resetIdle();
      return true;
    },
    stop: beginStop,
  };
}
