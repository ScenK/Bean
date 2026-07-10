import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "@bean/core";

export type RunDelegateFn = (req: DelegateRequest, callbacks: DelegateCallbacks) => DelegateHandle;

export interface RunEvents {
  onTail: (line: string) => void;
  onDone: (result: string) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}

interface ActiveRun {
  handle: DelegateHandle;
  timer: ReturnType<typeof setInterval>;
}

/** One active delegate run per project path; tail output throttled to one card
 * edit per interval (Teams rate-limits message edits). */
export class RunRegistry {
  private byProject = new Map<string, ActiveRun>();
  private eventsByProject = new Map<string, RunEvents>();

  constructor(
    private runDelegate: RunDelegateFn,
    private throttleMs = 5_000,
  ) {}

  isRunning(projectPath: string): boolean {
    return this.byProject.has(projectPath);
  }

  // A run that fails to spawn settles synchronously: onError fires (and free() runs)
  // before start() ever reaches its map inserts — the `settled` flag guards that hole.
  start(req: DelegateRequest, events: RunEvents): boolean {
    if (this.byProject.has(req.projectPath)) return false;
    let latest: string | undefined;
    let settled = false;
    const timer = setInterval(() => {
      if (latest === undefined) return;
      const line = latest;
      latest = undefined;
      events.onTail(line);
    }, this.throttleMs);
    const free = (): void => {
      settled = true;
      clearInterval(timer);
      this.byProject.delete(req.projectPath);
      this.eventsByProject.delete(req.projectPath);
    };
    const handle = this.runDelegate(req, {
      onOutput: (line) => { latest = line; },
      onDone: (result) => { free(); events.onDone(result); },
      onError: (err) => { free(); events.onError(err.message); },
    });
    if (!settled) {
      this.byProject.set(req.projectPath, { handle, timer });
      this.eventsByProject.set(req.projectPath, events);
    }
    return true;
  }

  cancel(projectPath: string): boolean {
    const active = this.byProject.get(projectPath);
    if (!active) return false;
    const events = this.eventsByProject.get(projectPath);
    clearInterval(active.timer);
    this.byProject.delete(projectPath);
    this.eventsByProject.delete(projectPath);
    active.handle.cancel(() => events?.onCancelled());
    return true;
  }

  cancelAll(): number {
    const paths = [...this.byProject.keys()];
    for (const p of paths) this.cancel(p);
    return paths.length;
  }
}
