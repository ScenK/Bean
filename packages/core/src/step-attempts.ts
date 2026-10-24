import { openDb } from "./db.js";
import type { StepKind } from "./routine-store.js";

/** One routine step attempt as kept in bean.db's `routine_step_attempts` — the full(er) record
 * behind `RunRecord.steps[].summary`. Never holds the rendered memories block or the composed
 * prompt (see .memory/convention-one-install-one-trust-domain.md). */
export interface StepAttempt {
  runId: string;
  routine: string;
  todoId?: string;
  stepId?: string;
  stepIndex: number;
  round: number;
  kind: StepKind;
  cli?: string;
  model?: string;
  sessionId?: string;
  ok: boolean;
  verdict?: string;
  /** Capped at STEP_OUTPUT_CAP on write (the tail is kept — the verdict/report lands last). */
  output: string;
  skillHash?: string;
  startedAt: string;
  finishedAt: string;
}

export const STEP_OUTPUT_CAP = 20_000;

/** The last `VERDICT: …` line of a step's output. Parse the full output — before any cap. */
export function parseVerdict(output: string): string | undefined {
  // Line scan, not a `(.+?)[ \t]*$` regex: that backtracks quadratically on long tab/space runs.
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("VERDICT:")) continue;
    const value = line.slice("VERDICT:".length).trim();
    if (value) return value;
  }
  return undefined;
}

/** A gate's verdict: PASS only when the last non-empty line is exactly `VERDICT: PASS`.
 * Missing, malformed, or a VERDICT line anywhere else (quoted, mid-output) is FAIL. */
export function gateVerdict(output: string): "PASS" | "FAIL" {
  return /^VERDICT:[ \t]*PASS$/.test(lastLine(output)) ? "PASS" : "FAIL";
}

/** The last non-empty line, trimmed ("" when there is none). */
export const lastLine = (output: string): string => output.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";

/** A route's choice: the label only when the last non-empty line is exactly `ROUTE: <label>` and
 * `labels` declares it. Missing, malformed, quoted, mid-output, or undeclared = undefined. */
export function routeLabel(output: string, labels: string[]): string | undefined {
  const label = /^ROUTE:[ \t]*([a-z0-9-]+)$/.exec(lastLine(output))?.[1];
  return label !== undefined && labels.includes(label) ? label : undefined;
}

/** `output` without a trailing `ROUTE:` line — Bean's routing signal, not part of the report. */
export function dropRouteLine(output: string): string {
  const lines = output.trimEnd().split(/\r?\n/);
  return lines.at(-1)?.trim().startsWith("ROUTE:") ? lines.slice(0, -1).join("\n").trimEnd() : output;
}

/** Never throws — bookkeeping must not fail or alter the run. Logs the error class only. */
export function recordStepAttempt(file: string, a: StepAttempt): void {
  try {
    openDb(file).prepare(
      `INSERT INTO routine_step_attempts (run_id, routine, todo_id, step_id, step_index, round, kind, cli, model,
         session_id, ok, verdict, output, skill_hash, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.runId, a.routine, a.todoId ?? null, a.stepId ?? null, a.stepIndex, a.round, a.kind, a.cli ?? null, a.model ?? null,
      a.sessionId ?? null, a.ok ? 1 : 0, a.verdict ?? null, a.output.slice(-STEP_OUTPUT_CAP), a.skillHash ?? null,
      a.startedAt, a.finishedAt,
    );
  } catch (err) {
    console.warn("bean: couldn't record a routine step attempt:", err instanceof Error ? err.name : "error");
  }
}

interface Row {
  run_id: string; routine: string; todo_id: string | null; step_id: string | null; step_index: number; round: number;
  kind: StepKind; cli: string | null; model: string | null; session_id: string | null; ok: number;
  verdict: string | null; output: string; skill_hash: string | null; started_at: string; finished_at: string;
}

/** A run's attempts in the order they ran. */
export function listStepAttempts(file: string, runId: string): StepAttempt[] {
  const rows = openDb(file)
    .prepare("SELECT * FROM routine_step_attempts WHERE run_id = ? ORDER BY id")
    .all(runId) as unknown as Row[];
  return rows.map((r) => ({
    runId: r.run_id, routine: r.routine, stepIndex: r.step_index, round: r.round, kind: r.kind, ok: r.ok === 1,
    output: r.output, startedAt: r.started_at, finishedAt: r.finished_at,
    ...(r.todo_id ? { todoId: r.todo_id } : {}),
    ...(r.step_id ? { stepId: r.step_id } : {}),
    ...(r.cli ? { cli: r.cli } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(r.skill_hash ? { skillHash: r.skill_hash } : {}),
  }));
}

/** Keeps a run's attempts past history eviction while something (a pending skill proposal)
 * still points at them; unpin once it's resolved. */
export function pinStepAttempts(file: string, runId: string, pinned: boolean): void {
  openDb(file).prepare("UPDATE routine_step_attempts SET pinned = ? WHERE run_id = ?").run(pinned ? 1 : 0, runId);
}

/** Drops `routine`'s unpinned attempts whose run isn't in `keepRunIds` — evicted runs and runs
 * that never produced a RunRecord (interrupted). Call only while no run of `routine` is live. */
export function pruneStepAttempts(file: string, routine: string, keepRunIds: string[]): void {
  openDb(file)
    .prepare(`DELETE FROM routine_step_attempts WHERE routine = ? AND pinned = 0
              AND run_id NOT IN (SELECT value FROM json_each(?))`)
    .run(routine, JSON.stringify(keepRunIds));
}
