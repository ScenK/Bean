// Multi-turn interactive counterpart to delegate.ts's one-shot runDelegate: a long-lived
// `claude -p` process fed user turns over stdin (stream-json), streaming events back on
// stdout, driven remotely from a chatops channel. Spec: docs/superpowers/specs/
// 2026-07-18-live-sessions-design.md — permissions are deliberately bypassed (true bypass).

import { spawn, type ChildProcess } from "node:child_process";
import { BEAN_GIT_IDENTITY, GIT_TRAILER_INSTRUCTION, claudeTailLine } from "./delegate.js";

export interface LiveSessionRequest {
  projectPath: string;
  /** The opening instruction — written to stdin as the first user turn. */
  prompt: string;
  /** Literal --model value (clis.json); flag omitted when unset. */
  model?: string;
  /** Claude session id to continue (`--resume`). Only pass an id Bean recorded in delegate_runs. */
  resume?: string;
}

/** A resumed session that exited before claude's `system/init` event: the host rejected the
 * id (expired or removed), so no session ever ran. */
export const RESUME_REJECTED = "Couldn't reopen that session (expired or removed on the host). Nothing was started.";

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
  onTurnComplete: (summary: TurnSummary) => void;
  /** Fires exactly once. undefined = clean end (stop/idle/exit 0); Error = crash. */
  onExit: (err?: Error) => void;
}

export interface LiveSessionHandle {
  send: (text: string) => void;
  stop: () => void;
  pid: number | undefined;
}

export type LiveSessionSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;

// stdin is "pipe" (delegate uses "ignore") — the whole point is writing further turns.
const defaultLiveSpawn: LiveSessionSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY } });

export const LIVE_SESSION_IDLE_MS = 30 * 60_000;

export function startLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn: LiveSessionSpawnFn = defaultLiveSpawn,
  idleTimeoutMs: number = LIVE_SESSION_IDLE_MS,
): LiveSessionHandle {
  const { command, args } = liveSessionCommand(req);
  const child = spawnFn(command, args, req.projectPath);

  let exited = false;
  let stopping = false;
  // A bad --resume id makes claude emit an error `result` and exit before `system/init`.
  let initSeen = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  const beginStop = (): void => {
    if (exited || stopping) return;
    stopping = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
  };

  const resetIdle = (): void => {
    if (exited) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(beginStop, idleTimeoutMs);
  };

  let stdoutBuf = "";
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
    if (e?.type === "system" && e.subtype === "init") initSeen = true;
    // Pre-init on a resume, a `result` is claude's rejection, not a turn — the exit reports it.
    if (req.resume && !initSeen) return;
    const summary = claudeTurnSummary(event);
    if (summary) {
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

  child.stdout?.on("data", (chunk: Buffer) => {
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
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
  });

  const settle = (err?: Error): void => {
    if (exited) return;
    exited = true;
    clearTimeout(idleTimer);
    clearTimeout(killTimer);
    cbs.onExit(err);
  };

  child.on("error", (err: Error) => settle(err));
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
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

  child.stdin?.write(userTurnLine(req.prompt + GIT_TRAILER_INSTRUCTION));
  resetIdle();

  return {
    pid: child.pid,
    send: (text) => {
      if (exited || stopping) return;
      child.stdin?.write(userTurnLine(text));
      resetIdle();
    },
    stop: beginStop,
  };
}
