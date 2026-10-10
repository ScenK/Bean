// Shared per-turn live-session engine for CLIs with no multi-turn stdin protocol (codex,
// opencode): one spawn per turn, every turn resuming the same CLI session. Each CLI plugs in a
// small TurnAdapter (codex-live-session.ts, opencode-live-session.ts); claude's long-lived
// stream-json process (live-session.ts) is separate. Unlike runDelegate, a rejected resume never
// falls back to a fresh run. See .memory/project-live-sessions.md.

import { spawn, type ChildProcess } from "node:child_process";
import { BEAN_GIT_IDENTITY, GIT_TRAILER_INSTRUCTION } from "./delegate.js";
import { escalateKill } from "./kill-tree.js";
import {
  LIVE_SESSION_IDLE_MS, RESUME_REJECTED,
  type LiveSessionCallbacks, type LiveSessionHandle, type LiveSessionRequest, type LiveSessionSpawnFn,
} from "./live-session.js";

export const TURN_QUEUE_FULL = "That's more than I can queue for the next turn — wait for this turn to finish, then send it.";
/** Aggregate cap for messages merged into the next turn while one is running. */
export const TURN_QUEUE_LIMIT = 4000;

/** What one stdout event means to the engine; any subset may be set. */
export interface TurnEvent {
  /** The session this turn runs in (proves it started). */
  sessionId?: string;
  /** The turn finished successfully. */
  completed?: boolean;
  /** A chat-safe failure reason (never raw provider text that could echo secrets). */
  failure?: string;
  /** Latest final-answer candidate; the last one wins. */
  result?: string;
  /** One running-tail line for chat. */
  tail?: string;
}

export interface TurnAdapter {
  command: string;
  args: (req: { prompt: string; model?: string; resume?: string }) => string[];
  /** Checked before spawning a resume; false → RESUME_REJECTED without a spawn. */
  validResume: (id: string) => boolean;
  parse: (event: unknown) => TurnEvent;
  /** The CLI's stderr when it refused the resume id. */
  rejected: RegExp;
  /** A replacement failure reason (e.g. signed out), from the turn's failure and stderr tail. */
  failureText?: (failure: string | undefined, stderr: string) => string | undefined;
  /** The session reported a different id than the one resumed. */
  mismatch: string;
  /** Soft-stops the turn's child and returns the process groups to SIGKILL after 5s. */
  stop: (pid: number) => number[];
  /** End notices the registry shows as-is (not as "Live session died: …"). */
  endMessages: string[];
}

// stdin "ignore": opencode blocks forever on an open stdin pipe. `PWD`: opencode takes its working
// dir from an inherited PWD over the spawn cwd (#247).
const defaultTurnSpawn: LiveSessionSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY, PWD: cwd } });

export function startTurnLiveSession(
  adapter: TurnAdapter,
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn: LiveSessionSpawnFn = defaultTurnSpawn,
  idleTimeoutMs: number = LIVE_SESSION_IDLE_MS,
  now: () => number = Date.now,
): LiveSessionHandle {
  const cli = adapter.command;
  // The session every turn resumes; set by the first turn's session id on a fresh session.
  let sessionId = req.resume;
  let child: ChildProcess | undefined;
  let turns = 0;
  let pending = "";
  let exited = false;
  let stopping = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (err?: Error): void => {
    if (exited) return;
    exited = true;
    pending = "";
    clearTimeout(idleTimer);
    cbs.onExit(err);
  };

  // The SIGKILL backstop deliberately outlives the child's close: a CLI can exit at once on the
  // soft signal while its tool, in its own group, ignores it (kill-tree.ts).
  const interrupt = (c: ChildProcess): void => {
    if (typeof c.pid === "number") escalateKill(adapter.stop(c.pid));
    else c.kill("SIGKILL");
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
    // Armed during a turn too (reset on output), so a hung silent child can't hold the channel.
    armIdle();
    turns++;
    const first = turns === 1;
    const prompt = first ? text + GIT_TRAILER_INSTRUCTION : text;
    const startedAt = now();
    let sawSession = false;
    let mismatch = false;
    let completed = false;
    let failure: string | undefined;
    let result = "";
    let stdoutBuf = "";
    let stderrBuf = "";

    const c = spawnFn(cli, adapter.args({ prompt, model: req.model, resume: sessionId }), req.projectPath);
    child = c;
    cbs.onTurnStart?.();

    const handleLine = (line: string): void => {
      if (!line.trim() || child !== c || mismatch) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const e = adapter.parse(event);
      if (e.sessionId !== undefined) {
        sawSession = true;
        if (!sessionId) sessionId = e.sessionId;
        else if (e.sessionId !== sessionId) {
          // A different session than the one we resumed: stop it and show none of its output.
          mismatch = true;
          if (!stopping) interrupt(c);
          return;
        }
      }
      if (e.completed) completed = true;
      if (e.failure !== undefined) failure ??= e.failure;
      if (e.result !== undefined) result = e.result;
      if (stopping || !e.tail) return;
      cbs.onOutput(e.tail);
      armIdle();
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
      // Checked first: our own stop exits non-zero, and a stop reports no turn footer.
      if (stopping) { finish(); return; }
      if (mismatch) { finish(new Error(adapter.mismatch)); return; }
      const override = adapter.failureText?.(failure, stderrBuf);
      const failed = override ?? failure;
      // stderr stays in the host log: it carries paths and diagnostics, and chat is shared.
      const died = `${cli} exited with code ${code ?? "null"}`;
      if (code !== 0 && stderrBuf.trim()) console.warn(`bean: ${cli} live turn failed: ${stderrBuf.trim().split("\n").slice(-5).join("\n")}`);
      if (first && !sawSession) {
        // Nothing to keep: the resume was rejected, or a fresh session never started.
        finish(new Error(
          override
          ?? (req.resume && adapter.rejected.test(stderrBuf) ? RESUME_REJECTED : failed ?? died),
        ));
        return;
      }
      const durationMs = now() - startedAt;
      // completed wins over an earlier failure event (codex reports retried stream errors too).
      const summary = completed ? { result, durationMs } : {
        result: "", durationMs,
        failed: failed ?? (code === 0 ? `${cli} exited without finishing the turn` : died),
      };
      cbs.onTurnComplete(summary);
      // After the callback (its typing stop must precede the next turn's start); a send() from
      // inside it may already have started that turn, or a stop() ended the session.
      if (exited || stopping || child) return;
      if (pending) {
        const next = pending;
        pending = "";
        runTurn(next);
      } else armIdle();
    });
  };

  if (req.resume && !adapter.validResume(req.resume)) {
    queueMicrotask(() => finish(new Error(RESUME_REJECTED)));
  } else runTurn(req.prompt);

  return {
    get pid() { return child?.pid; },
    send: (text) => {
      if (exited || stopping) return true;
      if (!child) { runTurn(text); return true; }
      const merged = pending ? `${pending}\n\n${text}` : text;
      if (merged.length > TURN_QUEUE_LIMIT) return false;
      pending = merged;
      return true;
    },
    stop: beginStop,
  };
}
