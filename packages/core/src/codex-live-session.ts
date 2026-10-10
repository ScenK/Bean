// Codex counterpart to live-session.ts: codex has no multi-turn stdin protocol, so a live
// session is one `codex exec [resume <thread>]` spawn per turn, all in the same thread. Same
// permissions bypass as codex delegate runs. Unlike runDelegate, a rejected resume never falls
// back to a fresh run. See .memory/project-live-sessions.md.

import { spawn, type ChildProcess } from "node:child_process";
import { BEAN_GIT_IDENTITY, GIT_TRAILER_INSTRUCTION, codexExecArgs, codexResult, codexTailLine } from "./delegate.js";
import { isCodexSessionId } from "./delegate-runs.js";
import {
  LIVE_SESSION_IDLE_MS, RESUME_REJECTED,
  type LiveSessionCallbacks, type LiveSessionHandle, type LiveSessionRequest, type LiveSessionSpawnFn,
} from "./live-session.js";

export const CODEX_SIGNED_OUT = "Codex is signed out on the host — someone needs to run `codex login` on that Mac.";
export const CODEX_THREAD_MISMATCH = "Couldn't reopen that session — codex started a different one, which was stopped.";
export const CODEX_QUEUE_FULL = "That's more than I can queue for the next turn — wait for this turn to finish, then send it.";
/** Aggregate cap for messages merged into the next turn while one is running. */
export const CODEX_QUEUE_LIMIT = 4000;

const AUTH_ERROR = /\b(401|unauthori[sz]ed|not (?:signed|logged) in|codex login)\b/i;

const defaultCodexSpawn: LiveSessionSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY } });

/** One tail line per codex event; a shell command shows as `▸ shell` (no raw argv or paths in chat). */
function codexLiveTail(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown } } | null;
  if (e?.type === "item.completed" && e.item?.type === "command_execution") return "▸ shell";
  return codexTailLine(event);
}

function failureOf(event: unknown): string | undefined {
  const e = event as { type?: unknown; message?: unknown; error?: { message?: unknown } } | null;
  if (e?.type === "turn.failed") return typeof e.error?.message === "string" && e.error.message ? e.error.message : "turn failed";
  if (e?.type === "error") return typeof e.message === "string" && e.message ? e.message : "error";
  return undefined;
}

export function startCodexLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn: LiveSessionSpawnFn = defaultCodexSpawn,
  idleTimeoutMs: number = LIVE_SESSION_IDLE_MS,
  now: () => number = Date.now,
): LiveSessionHandle {
  // The thread every turn resumes; set by the first turn's thread.started on a fresh session.
  let threadId = req.resume;
  let child: ChildProcess | undefined;
  let turns = 0;
  let pending = "";
  let exited = false;
  let stopping = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (err?: Error): void => {
    if (exited) return;
    exited = true;
    pending = "";
    clearTimeout(idleTimer);
    clearTimeout(killTimer);
    cbs.onExit(err);
  };

  const kill = (c: ChildProcess, signal: NodeJS.Signals): void => {
    try {
      if (typeof c.pid === "number") process.kill(-c.pid, signal);
      else c.kill(signal);
    } catch {
      c.kill(signal);
    }
  };

  // SIGINT, not SIGTERM: codex puts tool commands in their own process group, and only SIGINT
  // makes it stop them (SIGTERM/SIGKILL orphan them, #237). SIGKILL after 5s as the backstop.
  const interrupt = (c: ChildProcess): void => {
    kill(c, "SIGINT");
    killTimer = setTimeout(() => kill(c, "SIGKILL"), 5_000);
  };

  const beginStop = (): void => {
    if (exited || stopping) return;
    stopping = true;
    pending = "";
    if (child) interrupt(child);
    else finish();
  };

  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(beginStop, idleTimeoutMs);
  };

  const runTurn = (text: string): void => {
    clearTimeout(idleTimer);
    turns++;
    const first = turns === 1;
    const prompt = first ? text + GIT_TRAILER_INSTRUCTION : text;
    const startedAt = now();
    let sawThread = false;
    let mismatch = false;
    let completed = false;
    let failure: string | undefined;
    let result = "";
    let stdoutBuf = "";
    let stderrBuf = "";

    const c = spawnFn("codex", codexExecArgs({ prompt, model: req.model, resume: threadId }), req.projectPath);
    child = c;

    const handleLine = (line: string): void => {
      if (!line.trim() || child !== c || mismatch) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const e = event as { type?: unknown; thread_id?: unknown } | null;
      if (e?.type === "thread.started" && typeof e.thread_id === "string") {
        sawThread = true;
        if (!threadId) threadId = e.thread_id;
        else if (e.thread_id !== threadId) {
          // A different thread than the one we resumed: stop it and show none of its output.
          mismatch = true;
          if (!stopping) interrupt(c);
        }
        return;
      }
      if (e?.type === "turn.completed") { completed = true; return; }
      const failed = failureOf(event);
      if (failed !== undefined) { failure ??= failed; return; }
      const r = codexResult(event);
      if (r !== undefined) result = r;
      if (stopping) return;
      const tail = codexLiveTail(event);
      if (tail) cbs.onOutput(tail);
    };

    c.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
        handleLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    });
    // Drained even though only its tail is used: a full stderr pipe blocks the child.
    c.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
    });

    c.on("error", (err: Error) => {
      if (child !== c) return;
      child = undefined;
      finish(err);
    });
    c.on("close", (code: number | null) => {
      if (child !== c) return;
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      child = undefined;
      clearTimeout(killTimer);
      // Checked first: our own SIGINT exits 1, and a stop reports no turn footer.
      if (stopping) { finish(); return; }
      if (mismatch) { finish(new Error(CODEX_THREAD_MISMATCH)); return; }
      const stderrTail = stderrBuf.trim().split("\n").slice(-5).join("\n");
      const signedOut = AUTH_ERROR.test(`${failure ?? ""}\n${stderrBuf}`);
      const died = `codex exited with code ${code ?? "null"}${stderrTail ? ` - ${stderrTail}` : ""}`;
      if (first && !sawThread) {
        // Nothing to keep: the resume was rejected, or a fresh session never got a thread.
        finish(new Error(
          signedOut ? CODEX_SIGNED_OUT
          : req.resume && /no rollout found/i.test(stderrBuf) ? RESUME_REJECTED
          : failure ?? died,
        ));
        return;
      }
      const durationMs = now() - startedAt;
      // turn.completed wins over an earlier error event (codex reports retried stream errors too).
      const summary = completed ? { result, durationMs } : {
        result: "", durationMs,
        failed: signedOut ? CODEX_SIGNED_OUT : failure ?? (code === 0 ? "codex exited without finishing the turn" : died),
      };
      // Next turn decided before the callback, so a send() from inside it queues instead of
      // spawning a second concurrent turn.
      if (pending) {
        const next = pending;
        pending = "";
        runTurn(next);
      } else armIdle();
      cbs.onTurnComplete(summary);
    });
  };

  if (req.resume && !isCodexSessionId(req.resume)) {
    // Never spawned: codex would treat a non-UUID id as a thread name and start a new thread.
    queueMicrotask(() => finish(new Error(RESUME_REJECTED)));
  } else runTurn(req.prompt);

  return {
    get pid() { return child?.pid; },
    send: (text) => {
      if (exited || stopping) return true;
      if (!child) { runTurn(text); return true; }
      const merged = pending ? `${pending}\n\n${text}` : text;
      if (merged.length > CODEX_QUEUE_LIMIT) return false;
      pending = merged;
      return true;
    },
    stop: beginStop,
  };
}
