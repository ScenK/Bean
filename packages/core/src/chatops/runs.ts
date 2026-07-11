import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "../delegate.js";

export type RunDelegateFn = (req: DelegateRequest, callbacks: DelegateCallbacks) => DelegateHandle;

export interface RunEvents {
  onTail: (line: string) => void;
  onDone: (result: string) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
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
}

/** One active delegate run per project path; tail output throttled to one card
 * edit per interval (Teams rate-limits message edits). */
export class RunRegistry {
  private byProject = new Map<string, ActiveRun>();

  constructor(
    private runDelegate: RunDelegateFn,
    private throttleMs = 5_000,
  ) {}

  isRunning(projectPath: string): boolean {
    return this.byProject.has(projectPath);
  }

  // A run that fails to spawn settles synchronously: onError fires (and free() runs)
  // before start() ever reaches its map insert — `run.released` guards that hole.
  start(req: DelegateRequest, events: RunEvents): boolean {
    if (this.byProject.has(req.projectPath)) return false;
    let latest: string | undefined;
    const timer = setInterval(() => {
      if (latest === undefined) return;
      const line = latest;
      latest = undefined;
      events.onTail(line);
    }, this.throttleMs);
    const run: ActiveRun = { handle: undefined, timer, events, released: false };
    // Release this run only: mark it stale, stop its timer, and remove it from
    // the registry only if it is still the run registered for this path.
    const free = (): void => {
      run.released = true;
      clearInterval(timer);
      if (this.byProject.get(req.projectPath) === run) {
        this.byProject.delete(req.projectPath);
      }
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
    run.handle?.cancel(() => run.events.onCancelled());
    return true;
  }

  cancelAll(): number {
    const paths = [...this.byProject.keys()];
    for (const p of paths) this.cancel(p);
    return paths.length;
  }
}
