import { randomUUID } from "node:crypto";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "../delegate.js";
import { outboxDir } from "../config.js";
import { enqueueOutbox } from "../outbox.js";
import { reserveRun, releaseRun } from "../run-queue.js";

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
  reservationId: string;
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
    const reservation = await reserveRun(this.opts.dir, req.projectPath, process.pid, () => this.newId());
    if (!reservation) return false;
    // Lost an in-process race while awaiting the disk check above — release the now-redundant
    // reservation and defer to whichever call already won the in-memory map.
    if (this.byProject.has(req.projectPath)) {
      await releaseRun(this.opts.dir, reservation.id);
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
    const run: ActiveRun = { handle: undefined, timer, events, released: false, reservationId: reservation.id, meta };
    // Release this run only: mark it stale, stop its timer, release its reservation, and remove
    // it from the registry only if it is still the run registered for this path.
    const free = (): void => {
      run.released = true;
      clearInterval(timer);
      if (this.byProject.get(req.projectPath) === run) {
        this.byProject.delete(req.projectPath);
      }
      void releaseRun(this.opts.dir, run.reservationId);
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
    if (!run.released) this.byProject.set(req.projectPath, run);
    return true;
  }

  cancel(projectPath: string): boolean {
    const run = this.byProject.get(projectPath);
    if (!run) return false;
    run.released = true;
    clearInterval(run.timer);
    this.byProject.delete(projectPath);
    void releaseRun(this.opts.dir, run.reservationId);
    run.handle?.cancel(() => run.events.onCancelled());
    return true;
  }

  cancelAll(): number {
    const paths = [...this.byProject.keys()];
    for (const p of paths) this.cancel(p);
    return paths.length;
  }

  /** Called only when this process is dying (bot subprocess SIGTERM). Unlike cancel(), doesn't
   * wait for confirmation or emit onCancelled — nothing is listening — and instead durably
   * notifies the requesting conversation via the outbox so it survives the restart. */
  async interruptAll(): Promise<number> {
    const paths = [...this.byProject.keys()];
    for (const p of paths) {
      const run = this.byProject.get(p)!;
      run.released = true;
      clearInterval(run.timer);
      this.byProject.delete(p);
      run.handle?.cancel(() => {});
      await releaseRun(this.opts.dir, run.reservationId);
      await enqueueOutbox(
        outboxDir(this.opts.dir),
        {
          transport: this.opts.botKind,
          channel: run.meta.conversationId,
          body: `Run on ${p} ("${run.meta.instruction}") was interrupted when Bean closed. Ask me again to retry.`,
        },
        () => this.newId(),
      );
    }
    return paths.length;
  }
}
