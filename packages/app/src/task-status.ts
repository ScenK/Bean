// What the avatar's status bubbles show: one entry per delegate task or routine run Bean is
// working on (design 2a). Main owns the list and pushes the whole thing on every change.
export interface TaskJob {
  id: string;
  kind: "delegate" | "routine";
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
}

// How long a finished/failed/stopped bubble stays before it clears (the design said a minute;
// 10s proved enough to notice the result).
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
    finish(id: string, state: "done" | "failed", line: string): void {
      const cur = jobs.get(id);
      if (!cur) return;
      jobs.set(id, { ...cur, state, line });
      push();
      const prev = lingers.get(id);
      if (prev !== undefined) timers.clear(prev);
      lingers.set(id, timers.set(() => { lingers.delete(id); jobs.delete(id); push(); }, FINISHED_LINGER_MS));
    },
  };
}
