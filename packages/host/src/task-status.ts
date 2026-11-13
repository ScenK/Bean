// What the avatar's status bubbles show: one entry per thing Bean is working on (design 2a) —
// delegate tasks, routine runs, chat turns — plus failures, so a glance says Bean is alive or
// broken. Main owns the list and pushes the whole thing on every change.
import type { LiveCli, RoutineHostStatus } from "@bean/core";

export interface TaskJob {
  id: string;
  kind: "delegate" | "routine" | "chat" | "bot" | "reminder" | "memory" | "live";
  /** A desktop live session's agent — the pet wears its badge while the job runs. */
  agent?: LiveCli;
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
  /** A finished routine's run record `startedAt` — what its click opens in the Dashboard. The id is
   * reused per routine, so `start` and `finish` always set it rather than inheriting the last run's. */
  runStartedAt?: string;
  /** The desktop chat (mount id) that owns a delegate or live session — what its click opens. */
  mountId?: string;
  /** A sprout run's own name, from the host's start event (`name` may be a todo's text) — what its
   * Stop stops. */
  routine?: string;
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
    /** `sticky` (default: failed) keeps the bubble until dismiss(); otherwise it lingers briefly.
     * `patch` lands with the state change (one push). */
    finish(id: string, state: "done" | "failed", line: string, sticky = state === "failed", patch: Partial<Omit<TaskJob, "id">> = {}): void {
      const cur = jobs.get(id);
      if (!cur) return;
      jobs.set(id, { ...cur, ...patch, state, line });
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

type TaskStatus = ReturnType<typeof createTaskStatus>;

/** A stopping sprout bubble's line — the renderer disables its Stop on it. */
export const STOPPING_LINE = "Stopping…";

/** Core's routine host events onto the registry, plus the user's Stop: `stopping(routine)` turns that
 * sprout's running bubbles to "Stopping…" at once, and later step events can't overwrite it. A
 * stopped finish lingers and clears like a delegate's Stop — it isn't a failure to chase. */
export function createRoutineBubbles(status: TaskStatus) {
  const stopping = new Set<string>(); // bubble ids
  return {
    onStatus(e: RoutineHostStatus): void {
      if (e.type === "start") {
        stopping.delete(e.id);
        status.upsert(e.id, { kind: "routine", name: e.name, routine: e.routine, line: e.steps[0] ?? "", detail: e.detail, steps: e.steps, step: 0, startedAt: e.startedAt, state: "running", runStartedAt: undefined });
      } else if (e.type === "step") {
        if (!stopping.has(e.id)) status.upsert(e.id, { step: e.step, line: e.line });
      } else {
        stopping.delete(e.id);
        status.finish(e.id, e.state, e.line, e.stopped ? false : undefined, { runStartedAt: e.startedAt });
      }
    },
    stopping(routine: string): void {
      for (const j of status.list()) {
        if (j.kind !== "routine" || j.routine !== routine || j.state !== "running") continue;
        stopping.add(j.id);
        status.upsert(j.id, { line: STOPPING_LINE });
      }
    },
  };
}
