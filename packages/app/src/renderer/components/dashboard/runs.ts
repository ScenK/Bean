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

/** Runs finished after the last "mark all reviewed" — the rail's unread badge. */
export function unreadRuns(runs: DashRun[], reviewedAt: string | null): DashRun[] {
  return reviewedAt ? runs.filter((r) => r.finishedAt > reviewedAt) : runs;
}
