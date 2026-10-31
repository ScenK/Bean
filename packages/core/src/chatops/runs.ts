import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ChatopsActivitySink } from "./activity.js";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "../delegate.js";
import { dbFile, outboxDir } from "../config.js";
import { delegateRunProject, isValidSessionId, recordDelegateSession } from "../delegate-runs.js";
import { enqueueOutbox } from "../outbox.js";
import { recordRun, releaseRun, updateRunPid, interruptedRunNotice } from "../run-queue.js";

export type RunDelegateFn = (req: DelegateRequest, callbacks: DelegateCallbacks) => DelegateHandle;

/** `sessionId` on every terminal event is the started session's validated id (absent if the
 * run died before its session started) — the finished card's resume receipt. */
export interface RunEvents {
  onTail: (line: string) => void;
  onDone: (result: string, sessionId?: string) => void;
  onError: (message: string, sessionId?: string) => void;
  onCancelled: (sessionId?: string) => void;
}

/** Reporting context for a run — carried only so interruptAll() can tell the requesting
 * surface what happened; not persisted (see .memory/project-durable-run-queue.md). */
export interface RunMeta {
  instruction: string;
  conversationId: string;
}

export interface RunRegistryOptions {
  /** ~/.bean, for the cross-process run record (run-queue.ts) and outbox. */
  dir: string;
  botKind: "discord" | "teams";
  newId?: () => string;
  throttleMs?: number;
  /** Run lifecycle for the desktop app's status bubbles (see activity.ts). */
  onActivity?: ChatopsActivitySink;
}

interface ActiveRun {
  projectPath: string;
  cli: DelegateRequest["cli"];
  /** undefined only while runDelegate() is still executing synchronously. */
  handle: DelegateHandle | undefined;
  timer: ReturnType<typeof setInterval>;
  events: RunEvents;
  /** Set once this run has settled (done/error) or been cancelled. Stale delegate
   * callbacks that fire afterwards become no-ops. */
  released: boolean;
  meta: RunMeta;
  sessionId?: string;
}

/** Active delegate runs keyed by run id (what a card's Cancel carries); any number may share a
 * project. Tail output throttled to one card edit per interval (Teams rate-limits message edits).
 * Each run is recorded in run-queue.ts for crash cleanup. */
export class RunRegistry {
  private byId = new Map<string, ActiveRun>();
  /** Cancelled runs whose child hasn't confirmed it stopped — still driving their session. */
  private stopping = new Set<ActiveRun>();

  /** Prefixed to a run's result when it started fresh because its thread was busy. */
  static readonly BUSY_THREAD_NOTICE = "Started a fresh session — this thread's other run is still going.\n\n";
  /** Prefixed when it started fresh because the thread's session ran on another project (no path: shared channels). */
  static projectSwitchNotice(cli: DelegateRequest["cli"]): string {
    return `Started a fresh session — this thread's earlier ${cli} session was on another project.\n\n`;
  }

  constructor(
    private runDelegate: RunDelegateFn,
    private opts: RunRegistryOptions,
  ) {}

  private newId(): string {
    return this.opts.newId?.() ?? randomUUID();
  }

  // A run that fails to spawn settles synchronously: onError fires (and free() runs)
  // before start() ever reaches its map insert — `run.released` guards that hole.
  /** Resolves to the new run's id (for cancel()). */
  async start(req: DelegateRequest, callerEvents: RunEvents, meta: RunMeta): Promise<string> {
    // A thread follow-up on another project starts fresh on every CLI: claude and codex would resume
    // across folders and carry the old project's context and paths; opencode hangs. A session with
    // no recorded project also starts fresh.
    let notice = "";
    if (req.resume && delegateRunProject(dbFile(this.opts.dir), req.resume) !== req.projectPath) {
      const { resume: _stale, ...fresh } = req;
      req = fresh;
      notice = RunRegistry.projectSwitchNotice(req.cli);
    }
    // Two live processes must never drive one CLI session: while this thread already has a run on
    // this CLI, the new one starts fresh (the thread pointer keeps whichever completes last).
    if (req.resume && [...this.byId.values(), ...this.stopping].some((r) => r.cli === req.cli && r.meta.conversationId === meta.conversationId)) {
      const { resume: _busy, ...fresh } = req;
      req = fresh;
      notice = RunRegistry.BUSY_THREAD_NOTICE;
    }
    const act = this.opts.onActivity;
    const runId = this.newId();
    recordRun(this.opts.dir, runId, req.projectPath, process.pid);
    const name = basename(req.projectPath) || "delegate";
    // Every settle path goes through `events` except interruptAll(): that one runs as the bot
    // process dies, and the app clears a dead bot's bubbles itself.
    const events: RunEvents = act
      ? {
          onTail: callerEvents.onTail, // output stays in the channel; see activity.ts
          onDone: (result, sessionId) => { act({ type: "run", phase: "done", id: runId, name }); callerEvents.onDone(result, sessionId); },
          onError: (message, sessionId) => { act({ type: "run", phase: "failed", id: runId, name }); callerEvents.onError(message, sessionId); },
          onCancelled: (sessionId) => { act({ type: "run", phase: "cancelled", id: runId, name }); callerEvents.onCancelled(sessionId); },
        }
      : callerEvents;
    act?.({ type: "run", phase: "start", id: runId, name });
    const throttleMs = this.opts.throttleMs ?? 5_000;
    let latest: string | undefined;
    const timer = setInterval(() => {
      if (latest === undefined) return;
      const line = latest;
      latest = undefined;
      events.onTail(line);
    }, throttleMs);
    const run: ActiveRun = { projectPath: req.projectPath, cli: req.cli, handle: undefined, timer, events, released: false, meta };
    // Release this run only: mark it stale, stop its timer, release its record, and remove
    // it from the registry. Only called
    // once the delegate's own close event has actually fired (onDone/onError) — i.e. once the
    // child process is *confirmed* dead, not just asked to stop (see cancel()/interruptAll()
    // below, which intentionally do NOT go through this same-tick release).
    const free = (): void => {
      run.released = true;
      clearInterval(timer);
      this.byId.delete(runId);
      releaseRun(this.opts.dir, runId);
    };
    run.handle = this.runDelegate(req, {
      onOutput: (line) => {
        if (!run.released) latest = line;
      },
      onDone: (result) => {
        if (run.released) return;
        free();
        events.onDone(notice + result, run.sessionId);
      },
      onError: (err) => {
        if (run.released) return;
        free();
        events.onError(err.message, run.sessionId);
      },
      // A resumed run may re-spawn fresh if the CLI rejects the id; the first child is dead by
      // then, so a record on its pid would miss the live retry. Keep this (live) process's pid
      // until the session has started and no retry can happen.
      // ponytail: a bot killed in that ~1s window leaves the record on its own dead pid.
      onSessionStart: (pid, sessionId) => {
        if (req.resume && !run.released && pid !== undefined) updateRunPid(this.opts.dir, runId, pid);
        // Every started run is recorded (not just resumes), so failed/cancelled ones can be reopened.
        if (isValidSessionId(sessionId)) run.sessionId = sessionId;
        recordDelegateSession(dbFile(this.opts.dir), {
          surface: this.opts.botKind, cli: req.cli, sessionId, projectPath: req.projectPath, instruction: run.meta.instruction,
        });
      },
    });
    // The record was created against this process's own pid (nothing else to track before the
    // child exists); switch it to the child's real pid now so a later interruptAll() can leave
    // it in place and boot cleanup tracks *that child*, not this (possibly about-to-exit)
    // process. See run-queue.ts's doc comment.
    if (!req.resume && !run.released && run.handle.pid !== undefined) {
      updateRunPid(this.opts.dir, runId, run.handle.pid);
    }
    if (!run.released) this.byId.set(runId, run);
    return runId;
  }

  /** `conversationId` set = cancel only if the run was started from that conversation. */
  cancel(runId: string, conversationId?: string): boolean {
    const run = this.byId.get(runId);
    if (!run || (conversationId !== undefined && run.meta.conversationId !== conversationId)) return false;
    run.released = true;
    clearInterval(run.timer);
    this.byId.delete(runId);
    this.stopping.add(run);
    // Release only once the handle confirms the child has actually stopped (onCancelled fires
    // from the delegate's own close event) — the record must outlive a child that's still
    // shutting down (or ignoring SIGTERM) so crash cleanup can still find it.
    run.handle?.cancel(() => {
      this.stopping.delete(run);
      releaseRun(this.opts.dir, runId);
      run.events.onCancelled(run.sessionId);
    });
    return true;
  }

  /** `conversationId` set = only that conversation's runs. */
  cancelAll(conversationId?: string): number {
    const ids = [...this.byId.entries()]
      .filter(([, r]) => conversationId === undefined || r.meta.conversationId === conversationId)
      .map(([id]) => id);
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** Called only when this process is dying (bot subprocess SIGTERM). Unlike cancel(), doesn't
   * wait for confirmation or emit onCancelled — nothing is listening — and instead durably
   * notifies the requesting conversation via the outbox so it survives the restart.
   *
   * Deliberately does NOT release the run record: this process is exiting right after, with no
   * way to know whether the delegate child (sent SIGTERM below) has actually stopped by then.
   * The record already tracks the child's own pid (see start()), so it's left for boot cleanup
   * (desktop sweeps it once the child is dead; a headless boot kills it).
   *
   * Also deliberately synchronous (releaseRun/enqueueOutbox are sync-internally, see their doc
   * comments): a SIGTERM handler racing the process's own exit can't reliably wait on real
   * async work, so this must be guaranteed to have written everything to disk by the time it
   * returns, not just "eventually". */
  interruptAll(): number {
    const runs = [...this.byId.values()];
    this.byId.clear();
    for (const run of runs) {
      run.released = true;
      clearInterval(run.timer);
      run.handle?.cancel(() => {});
      const { full, display } = interruptedRunNotice(run.projectPath, run.meta.instruction);
      void enqueueOutbox(
        outboxDir(this.opts.dir),
        { transport: this.opts.botKind, channel: run.meta.conversationId, body: full, displayBody: display },
        () => this.newId(),
      );
    }
    return runs.length;
  }
}
