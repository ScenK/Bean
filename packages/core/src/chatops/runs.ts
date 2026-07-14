import { randomUUID } from "node:crypto";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "../delegate.js";
import { outboxDir } from "../config.js";
import { enqueueOutbox } from "../outbox.js";
import { reserveRun, releaseRun, updateReservationPid, interruptedRunNotice } from "../run-queue.js";

export type RunDelegateFn = (req: DelegateRequest, callbacks: DelegateCallbacks) => DelegateHandle;

export interface RunEvents {
  onTail: (line: string) => void;
  onDone: (result: string) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
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
}

interface ActiveRun {
  /** undefined only while runDelegate() is still executing synchronously. */
  handle: DelegateHandle | undefined;
  timer: ReturnType<typeof setInterval>;
  events: RunEvents;
  /** Set once this run has settled (done/error) or been cancelled. Stale delegate
   * callbacks that fire afterwards become no-ops instead of clobbering a newer
   * run on the same project path. */
  released: boolean;
  meta: RunMeta;
}

/** One active delegate run per project path; tail output throttled to one card
 * edit per interval (Teams rate-limits message edits). The in-memory `byProject` map is
 * this process's own guard; `reserveRun`/`releaseRun` (run-queue.ts) extend that same
 * single-run-per-project invariant across processes (desktop chat + the other bot). */
export class RunRegistry {
  private byProject = new Map<string, ActiveRun>();

  constructor(
    private runDelegate: RunDelegateFn,
    private opts: RunRegistryOptions,
  ) {}

  isRunning(projectPath: string): boolean {
    return this.byProject.has(projectPath);
  }

  private newId(): string {
    return this.opts.newId?.() ?? randomUUID();
  }

  // A run that fails to spawn settles synchronously: onError fires (and free() runs)
  // before start() ever reaches its map insert — `run.released` guards that hole.
  async start(req: DelegateRequest, events: RunEvents, meta: RunMeta): Promise<boolean> {
    if (this.byProject.has(req.projectPath)) return false;
    const reservation = reserveRun(this.opts.dir, req.projectPath, process.pid, () => this.newId());
    if (!reservation) return false;
    // Lost an in-process race — release the now-redundant reservation and defer to whichever
    // call already won the in-memory map. (byProject.has was already checked above; this
    // second check exists for symmetry if start() is ever made to await something before here.)
    if (this.byProject.has(req.projectPath)) {
      releaseRun(this.opts.dir, req.projectPath);
      return false;
    }
    const throttleMs = this.opts.throttleMs ?? 5_000;
    let latest: string | undefined;
    const timer = setInterval(() => {
      if (latest === undefined) return;
      const line = latest;
      latest = undefined;
      events.onTail(line);
    }, throttleMs);
    const run: ActiveRun = { handle: undefined, timer, events, released: false, meta };
    // Release this run only: mark it stale, stop its timer, release its reservation, and remove
    // it from the registry only if it is still the run registered for this path. Only called
    // once the delegate's own close event has actually fired (onDone/onError) — i.e. once the
    // child process is *confirmed* dead, not just asked to stop (see cancel()/interruptAll()
    // below, which intentionally do NOT go through this same-tick release).
    const free = (): void => {
      run.released = true;
      clearInterval(timer);
      if (this.byProject.get(req.projectPath) === run) {
        this.byProject.delete(req.projectPath);
      }
      releaseRun(this.opts.dir, req.projectPath);
    };
    run.handle = this.runDelegate(req, {
      onOutput: (line) => {
        if (!run.released) latest = line;
      },
      onDone: (result) => {
        if (run.released) return;
        free();
        events.onDone(result);
      },
      onError: (err) => {
        if (run.released) return;
        free();
        events.onError(err.message);
      },
    });
    // The reservation was created against this process's own pid (nothing else to track before
    // the child exists); switch it to the child's real pid now so a later interruptAll() can
    // leave the reservation in place and have the next reserveRun() correctly track *that
    // child*, not this (possibly about-to-exit) process. See run-queue.ts's doc comment.
    if (!run.released && run.handle.pid !== undefined) {
      updateReservationPid(this.opts.dir, req.projectPath, run.handle.pid);
    }
    if (!run.released) this.byProject.set(req.projectPath, run);
    return true;
  }

  cancel(projectPath: string): boolean {
    const run = this.byProject.get(projectPath);
    if (!run) return false;
    run.released = true;
    clearInterval(run.timer);
    this.byProject.delete(projectPath);
    // Release only once the handle confirms the child has actually stopped (onCancelled fires
    // from the delegate's own close event) — releasing eagerly here would let a new run start
    // on this project while the old child (sent SIGTERM, possibly still shutting down or
    // ignoring it) is still alive.
    run.handle?.cancel(() => {
      releaseRun(this.opts.dir, projectPath);
      run.events.onCancelled();
    });
    return true;
  }

  cancelAll(): number {
    const paths = [...this.byProject.keys()];
    for (const p of paths) this.cancel(p);
    return paths.length;
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
    const paths = [...this.byProject.keys()];
    for (const p of paths) {
      const run = this.byProject.get(p)!;
      run.released = true;
      clearInterval(run.timer);
      this.byProject.delete(p);
      run.handle?.cancel(() => {});
      const { full, display } = interruptedRunNotice(p, run.meta.instruction);
      void enqueueOutbox(
        outboxDir(this.opts.dir),
        { transport: this.opts.botKind, channel: run.meta.conversationId, body: full, displayBody: display },
        () => this.newId(),
      );
    }
    return paths.length;
  }
}
