import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ChatopsActivitySink } from "./activity.js";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "../delegate.js";
import { dbFile, outboxDir } from "../config.js";
import { delegateRunProject, isValidSessionId, recordDelegateSession } from "../delegate-runs.js";
import { enqueueOutbox } from "../outbox.js";
import { reserveRun, releaseRun, updateReservationPid, interruptedRunNotice } from "../run-queue.js";

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
  /** ~/.bean, for the cross-process project-path reservation (run-queue.ts) and outbox. */
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
   * callbacks that fire afterwards become no-ops instead of clobbering a newer
   * run on the same project path. */
  released: boolean;
  meta: RunMeta;
  sessionId?: string;
}

/** Active delegate runs keyed by run id (what a card's Cancel carries), still one per project
 * path; tail output throttled to one card edit per interval (Teams rate-limits message edits).
 * The in-memory map is this process's own guard; `reserveRun`/`releaseRun` (run-queue.ts) extend
 * that same single-run-per-project invariant across processes (desktop chat + the other bot). */
export class RunRegistry {
  private byId = new Map<string, ActiveRun>();

  /** Prefixed to a run's result when it started fresh because its thread was busy. */
  static readonly BUSY_THREAD_NOTICE = "Started a fresh session — this thread's other run is still going.\n\n";

  constructor(
    private runDelegate: RunDelegateFn,
    private opts: RunRegistryOptions,
  ) {}

  isRunning(projectPath: string): boolean {
    return [...this.byId.values()].some((r) => r.projectPath === projectPath);
  }

  private newId(): string {
    return this.opts.newId?.() ?? randomUUID();
  }

  // A run that fails to spawn settles synchronously: onError fires (and free() runs)
  // before start() ever reaches its map insert — `run.released` guards that hole.
  /** Resolves to the new run's id (for cancel()), or undefined when the project is busy. */
  async start(req: DelegateRequest, callerEvents: RunEvents, meta: RunMeta): Promise<string | undefined> {
    if (this.isRunning(req.projectPath)) return undefined;
    // opencode resuming a session from another folder emits nothing and never exits (claude
    // rejects it, codex adopts the new cwd), so a thread follow-up on another project starts fresh.
    if (req.cli === "opencode" && req.resume && delegateRunProject(dbFile(this.opts.dir), req.resume) !== req.projectPath) {
      const { resume: _stale, ...fresh } = req;
      req = fresh;
    }
    // Two live processes must never drive one CLI session: while this thread already has a run on
    // this CLI, the new one starts fresh (the thread pointer keeps whichever completes last).
    let notice = "";
    if (req.resume && [...this.byId.values()].some((r) => r.cli === req.cli && r.meta.conversationId === meta.conversationId)) {
      const { resume: _busy, ...fresh } = req;
      req = fresh;
      notice = RunRegistry.BUSY_THREAD_NOTICE;
    }
    const reservation = reserveRun(this.opts.dir, req.projectPath, process.pid, () => this.newId());
    if (!reservation) return undefined;
    // Lost an in-process race — release the now-redundant reservation and defer to whichever
    // call already won the in-memory map. (isRunning was already checked above; this second
    // check exists for symmetry if start() is ever made to await something before here.)
    if (this.isRunning(req.projectPath)) {
      releaseRun(this.opts.dir, req.projectPath);
      return undefined;
    }
    const act = this.opts.onActivity;
    const runId = this.newId();
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
    // Release this run only: mark it stale, stop its timer, release its reservation, and remove
    // it from the registry. Only called
    // once the delegate's own close event has actually fired (onDone/onError) — i.e. once the
    // child process is *confirmed* dead, not just asked to stop (see cancel()/interruptAll()
    // below, which intentionally do NOT go through this same-tick release).
    const free = (): void => {
      run.released = true;
      clearInterval(timer);
      this.byId.delete(runId);
      releaseRun(this.opts.dir, req.projectPath);
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
      // then, so a reservation on its pid would be reclaimable mid-run. Keep this (live) process's
      // pid until the session has started and no retry can happen.
      // ponytail: a bot killed in that ~1s window leaves the reservation on its own dead pid.
      onSessionStart: (pid, sessionId) => {
        if (req.resume && !run.released && pid !== undefined) updateReservationPid(this.opts.dir, req.projectPath, pid);
        // Every started run is recorded (not just resumes), so failed/cancelled ones can be reopened.
        if (isValidSessionId(sessionId)) run.sessionId = sessionId;
        recordDelegateSession(dbFile(this.opts.dir), {
          surface: this.opts.botKind, cli: req.cli, sessionId, projectPath: req.projectPath, instruction: run.meta.instruction,
        });
      },
    });
    // The reservation was created against this process's own pid (nothing else to track before
    // the child exists); switch it to the child's real pid now so a later interruptAll() can
    // leave the reservation in place and have the next reserveRun() correctly track *that
    // child*, not this (possibly about-to-exit) process. See run-queue.ts's doc comment.
    if (!req.resume && !run.released && run.handle.pid !== undefined) {
      updateReservationPid(this.opts.dir, req.projectPath, run.handle.pid);
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
    // Release only once the handle confirms the child has actually stopped (onCancelled fires
    // from the delegate's own close event) — releasing eagerly here would let a new run start
    // on this project while the old child (sent SIGTERM, possibly still shutting down or
    // ignoring it) is still alive.
    run.handle?.cancel(() => {
      releaseRun(this.opts.dir, run.projectPath);
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
   * Deliberately does NOT release the reservation: this process is exiting right after, with no
   * way to know whether the delegate child (sent SIGTERM below) has actually stopped by then —
   * releasing blind would let a relaunch start a second run on the same project while the old
   * child is still alive. The reservation already tracks the child's own pid (see start()), so
   * it's left in place and the *next* reserveRun() for this project will correctly report busy
   * until that child is verifiably gone (or reclaim it once it's not — same crash-recovery path
   * as an ungraceful exit).
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
