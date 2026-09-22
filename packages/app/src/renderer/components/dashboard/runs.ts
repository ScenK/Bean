import type { RunRecord } from "@bean/core";
import type { RoutineStateView } from "../../../ipc.js";

/** One routine run, tagged with the routine it came from — the dashboard reads every
 * routine's history as a single newest-first stream, not one routine at a time. */
export interface DashRun extends RunRecord {
  routine: string;
  /** `${routine}@${startedAt}` — stable across polls, so the selection survives a refresh. */
  id: string;
}

export interface DashStep {
  /** Position in the run's recorded step list — NOT the routine's step number when the
   * routine is todo-driven (the runner appends one pass of every step per todo). `todo`
   * disambiguates those; see stepLabel(). */
  index: number;
  kind: "delegate" | "chat";
  ok: boolean;
  summary: string;
  /** The todo this pass ran for, when the runner labelled the output `[todo: ...] `. */
  todo?: string;
}

const TODO_LABEL = /^\[todo: ([^\]]*)\] ?/;
const TODO_OPEN = "[todo: ";

/** The runner prefixes a todo pipeline's output with `[todo: <text>] ` — lift that out so the
 * card can name the todo instead of claiming a step number that doesn't line up.
 *
 * A summary is capped at 200 chars by the runner, so a long todo's prefix can arrive with its
 * `]` cut off; that still means "this was a todo pass", just without a usable name — never
 * "step N", which would be a wrong claim. A `]` inside the todo text itself only truncates the
 * displayed name (cosmetic): matching to the LAST `]` would misread the far more common case
 * of a `]` in the step's own output. */
export function parseStep(step: { kind: "delegate" | "chat"; ok: boolean; summary: string }, index: number): DashStep {
  const m = TODO_LABEL.exec(step.summary);
  if (m) return { index, kind: step.kind, ok: step.ok, summary: step.summary.slice(m[0].length), todo: m[1] };
  if (step.summary.startsWith(TODO_OPEN)) {
    return { index, kind: step.kind, ok: step.ok, summary: step.summary.slice(TODO_OPEN.length), todo: "" };
  }
  return { index, kind: step.kind, ok: step.ok, summary: step.summary };
}

/** What to call a step in the UI. A todo-labelled pass can't honestly claim "step N". */
export const stepLabel = (step: DashStep): string =>
  step.todo === undefined ? `step ${step.index + 1}` : "todo";

export const runId = (routine: string, startedAt: string): string => `${routine}@${startedAt}`;

/** Flattens routinesState() into one newest-first list of runs across every routine. */
export function flattenRuns(states: Record<string, RoutineStateView>): DashRun[] {
  const runs: DashRun[] = [];
  for (const [routine, state] of Object.entries(states)) {
    for (const record of state.history) {
      runs.push({ ...record, routine, id: runId(routine, record.startedAt) });
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A failed step is the only thing in a run that can actually need a decision; everything
 * else resolved without you and collapses to one line. */
export function splitSteps(run: DashRun | undefined): { needs: DashStep[]; resolved: DashStep[] } {
  const steps: DashStep[] = (run?.steps ?? []).map(parseStep);
  return { needs: steps.filter((s) => !s.ok), resolved: steps.filter((s) => s.ok) };
}

/** Runs you haven't marked reviewed — the rail's unread dot. Reviewing is per run rather than
 * a single "seen up to here" timestamp, because the panel marks one day at a time: a timestamp
 * would silently clear every older day too. */
export function unreadRuns(runs: DashRun[], reviewed: ReadonlySet<string>): DashRun[] {
  return runs.filter((r) => !reviewed.has(r.id));
}

/** Adds `ids` to the reviewed set, dropping any that no longer exist in `runs` — history is
 * capped, so without the prune the stored list would grow past what it can ever match. */
export function reviewRuns(reviewed: ReadonlySet<string>, ids: string[], runs: DashRun[]): string[] {
  const live = new Set(runs.map((r) => r.id));
  return [...new Set([...reviewed, ...ids])].filter((id) => live.has(id));
}

/** Every run a routine did on one local day — the dashboard's unit of selection and of
 * reading. The spine renders the whole bucket as one timeline, run after run. */
export interface RunBucket {
  /** `${date}|${routine}` — the selection key, stable across polls. */
  key: string;
  routine: string;
  /** Local calendar date of these runs, ISO `YYYY-MM-DD`; the panel formats the label. */
  date: string;
  /** Newest-first, like every other level — the latest run reads at the top of the spine. A
   * run's displayed ordinal is its chronological place in the day, so the first run of the day
   * is still RUN 1, it just sits at the bottom. */
  runs: DashRun[];
  /** Failed steps across the whole bucket — what the day still needs from you. */
  needs: number;
}

export interface DayGroup {
  /** The local date, which is also its fold key. */
  date: string;
  buckets: RunBucket[];
  runCount: number;
  needs: number;
}

const localDate = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const bucketKey = (date: string, routine: string): string => `${date}|${routine}`;

/** Rail shape: local day → routine → that routine's runs on that day. A routine that fires
 * several times a day becomes ONE row, whose runs the spine then reads newest-first. Input must
 * already be newest-first (flattenRuns' order), which every level here preserves. */
export function groupRuns(runs: DashRun[]): DayGroup[] {
  const days: DayGroup[] = [];
  const byDate = new Map<string, DayGroup>();
  const byBucket = new Map<string, RunBucket>();
  for (const run of runs) {
    const date = localDate(run.startedAt);
    let day = byDate.get(date);
    if (!day) {
      day = { date, buckets: [], runCount: 0, needs: 0 };
      byDate.set(date, day);
      days.push(day);
    }
    const key = bucketKey(date, run.routine);
    let bucket = byBucket.get(key);
    if (!bucket) {
      bucket = { key, routine: run.routine, date, runs: [], needs: 0 };
      byBucket.set(key, bucket);
      day.buckets.push(bucket);
    }
    bucket.runs.push(run);
    const failed = run.steps.filter((step) => !step.ok).length;
    bucket.needs += failed;
    day.runCount++;
    day.needs += failed;
  }
  return days;
}
