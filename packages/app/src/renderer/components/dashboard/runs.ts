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
  index: number;
  kind: "delegate" | "chat";
  ok: boolean;
  summary: string;
}

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
  const steps: DashStep[] = (run?.steps ?? []).map((s, index) => ({ index, ...s }));
  return { needs: steps.filter((s) => !s.ok), resolved: steps.filter((s) => s.ok) };
}

/** Runs finished after the last "mark all reviewed" — the rail's unread badge. */
export function unreadRuns(runs: DashRun[], reviewedAt: string | null): DashRun[] {
  return reviewedAt ? runs.filter((r) => r.finishedAt > reviewedAt) : runs;
}
