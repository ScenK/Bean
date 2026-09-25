// What the avatar's status bubbles show: one entry per thing Bean is working on (design 2a) —
// delegate tasks, routine runs, chat turns — plus failures, so a glance says Bean is alive or
// broken. Main owns the list and pushes the whole thing on every change.
export interface TaskJob {
  id: string;
  kind: "delegate" | "routine" | "chat" | "bot" | "reminder";
  name: string;
  /** One-line status: latest delegate output line, or the routine's current step label. */
  line: string;
  /** Shown when the bubble is expanded: the delegate's instruction. */
  detail: string;
  /** Routine step labels; `step` indexes the one running now. */
  steps?: string[];
  step?: number;
  startedAt: number;
  state: "running" | "done" | "failed";
  /** Repeats merged into one error bubble (see `error()`); absent means 1. */
  count?: number;
}

// How long a finished (or user-stopped) bubble stays before it clears (the design said a minute;
// 10s proved enough to notice the result). Failures don't linger-and-clear: they stay until the
// user clicks them away, since a failure that happened while you were away is the one to see.
export const FINISHED_LINGER_MS = 10_000;

export function createTaskStatus(
  send: (jobs: TaskJob[]) => void,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
) {
  const jobs = new Map<string, TaskJob>();
  const lingers = new Map<string, ReturnType<typeof setTimeout>>();
  const push = (): void => send([...jobs.values()]);

  return {
    list: (): TaskJob[] => [...jobs.values()],
    /** Create (needs every field) or patch an existing job. A patch for an unknown id is dropped. */
    upsert(id: string, patch: Partial<Omit<TaskJob, "id">>): void {
      const cur = jobs.get(id);
      if (!cur && !(patch.kind && patch.name !== undefined)) return;
      const t = lingers.get(id);
      if (t !== undefined) { timers.clear(t); lingers.delete(id); } // a rerun revives it
      jobs.set(id, { line: "", detail: "", startedAt: Date.now(), state: "running", ...cur, ...patch, id } as TaskJob);
      push();
    },
    /** `sticky` (default: failed) keeps the bubble until dismiss(); otherwise it lingers briefly. */
    finish(id: string, state: "done" | "failed", line: string, sticky = state === "failed"): void {
      const cur = jobs.get(id);
      if (!cur) return;
      jobs.set(id, { ...cur, state, line });
      push();
      const prev = lingers.get(id);
      if (prev !== undefined) { timers.clear(prev); lingers.delete(id); }
      if (!sticky) lingers.set(id, timers.set(() => { lingers.delete(id); jobs.delete(id); push(); }, FINISHED_LINGER_MS));
    },
    /** A standalone failure. Reusing an id that's already showing an error bumps its count
     * instead of stacking another bubble — a crash loop stays one bubble. */
    error(id: string, e: { kind: TaskJob["kind"]; name: string; line: string; detail?: string }): void {
      const cur = jobs.get(id);
      const count = cur?.state === "failed" ? (cur.count ?? 1) + 1 : 1;
      const t = lingers.get(id);
      if (t !== undefined) { timers.clear(t); lingers.delete(id); }
      jobs.set(id, { detail: "", ...e, id, startedAt: Date.now(), state: "failed", count });
      push();
    },
    dismiss(id: string): void {
      const t = lingers.get(id);
      if (t !== undefined) { timers.clear(t); lingers.delete(id); }
      if (jobs.delete(id)) push();
    },
  };
}
