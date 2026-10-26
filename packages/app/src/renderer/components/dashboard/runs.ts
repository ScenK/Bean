import type { FlowEdge, RoutineStep, RunRecord, StepKind } from "@bean/core";
import { stepFlow, stepGroups } from "@bean/core/routine-graph";
import type { FlowOverlay } from "../../shared/StepFlow.js";
import type { RoutineStateView, StepAttemptView } from "../../../ipc.js";

/** One routine run, tagged with the routine it came from — the dashboard reads every
 * routine's history as a single newest-first stream, not one routine at a time. */
export interface DashRun extends RunRecord {
  routine: string;
  /** `${routine}@${startedAt}` — stable across polls, so the selection survives a refresh. */
  id: string;
  /** The record's own uuid (RunRecord.id, which `id` shadows) — keys its step attempts in bean.db. */
  recordId?: string;
}

export interface DashStep {
  /** Position in the run's recorded step list — NOT the routine's step number when the
   * routine is todo-driven (the runner appends one pass of every step per todo). `todo`
   * disambiguates those; see stepLabel(). */
  index: number;
  kind: StepKind;
  ok: boolean;
  summary: string;
  /** The todo this pass ran for, when the runner labelled the output `[todo: ...] `. */
  todo?: string;
  /** Gated routines: the step's stable id, its round (executions so far this pass), harness and verdict. */
  id?: string;
  round?: number;
  cli?: string;
  verdict?: string;
}

type RecordedStep = RunRecord["steps"][number];

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
export function parseStep(step: { kind: StepKind; ok: boolean; summary: string } & Partial<RecordedStep>, index: number): DashStep {
  const extra = {
    ...(step.id ? { id: step.id } : {}), ...(step.round ? { round: step.round } : {}),
    ...(step.cli ? { cli: step.cli } : {}), ...(step.verdict ? { verdict: step.verdict } : {}),
  };
  const m = TODO_LABEL.exec(step.summary);
  if (m) return { index, kind: step.kind, ok: step.ok, summary: step.summary.slice(m[0].length), todo: m[1], ...extra };
  if (step.summary.startsWith(TODO_OPEN)) {
    return { index, kind: step.kind, ok: step.ok, summary: step.summary.slice(TODO_OPEN.length), todo: "", ...extra };
  }
  return { index, kind: step.kind, ok: step.ok, summary: step.summary, ...extra };
}

/** A gated step can finish `ok` with a FAIL verdict (the gate routed it) — that's not a pass. */
export const stepPassed = (step: { ok: boolean; verdict?: string }): boolean => step.ok && step.verdict !== "FAIL";

/** Name of an executed step: its id, plus the round when it ran more than once. */
export const pathName = (step: { kind: StepKind; id?: string; round?: number }): string =>
  `${step.id ?? step.kind}${step.round && step.round > 1 ? ` r${step.round}` : ""}`;

/** Step id → its first index in the definition. */
const idIndex = (steps: readonly RoutineStep[]): Map<string, number> => {
  const ids = new Map<string, number>();
  steps.forEach((s, i) => { if (s.id && !ids.has(s.id)) ids.set(s.id, i); });
  return ids;
};

/** The route a run actually took, e.g. `lint ✓ → test ✗ → implement r2 ✓ → test r2 ✓`; a route
 * step adds the path it picked: `triage ✓ ⑂bug → fix ✓`. Where `steps` (the definition) shows a
 * parallel group, its members read as one hop: `[lint ✓ | test ✗ | review ✓] → merge ✓`. */
export function executedPath(run: Pick<RunRecord, "steps">, steps: readonly RoutineStep[] = []): string {
  const ids = idIndex(steps);
  const groups = new Map(stepGroups(steps).map((g) => [g.first, g] as const));
  const one = (s: RecordedStep): string => `${pathName(s)} ${stepPassed(s) ? "✓" : "✗"}${s.chose ? ` ⑂${s.chose}` : ""}`;
  const parts: string[] = [];
  for (let k = 0; k < run.steps.length; k++) {
    const g = groups.get(ids.get(run.steps[k]!.id ?? "") ?? -1);
    const block = g ? run.steps.slice(k, k + g.last - g.first + 1) : [];
    if (g && block.length === g.last - g.first + 1 && block.every((b, j) => ids.get(b.id ?? "") === g.first + j)) {
      parts.push(`[${block.map(one).join(" | ")}]`);
      k += block.length - 1;
    } else parts.push(one(run.steps[k]!));
  }
  return parts.join(" → ");
}

/** Maps a run's recorded steps onto the sprout's current flow diagram. `"drift"` = the record no
 * longer fits today's definition (an unknown id, a hop with no edge, a legacy run whose kinds
 * don't line up) — draw the diagram plain and say so. Todo-driven runs are the union of their
 * passes; a pass restarts at the first step (round 1). A node is failed when its last execution
 * didn't pass, or it errored in an earlier pass (an error a later round of the same pass got past
 * — a group member retried on a loop — doesn't count). A parallel group's members are recorded together in step order: the
 * block lights every fork into it and every member's join, failed members included. Pure. */
export function runFlowOverlay(run: Pick<RunRecord, "steps">, steps: RoutineStep[]): FlowOverlay | "drift" {
  const { edges } = stepFlow(steps);
  const recs = run.steps;
  let at: number[];
  if (recs.every((r) => r.id)) {
    const ids = idIndex(steps);
    at = recs.map((r) => ids.get(r.id!) ?? -1);
  } else if (recs.some((r) => r.id) || steps.some((s) => s.gate || s.next !== undefined || s.route || s.alongside)) {
    return "drift";
  } else {
    // Legacy: positional. A todo pass starts over after the last step or a failed step (the
    // pipeline abandons that todo); a plain run is one pass that continues past a failure.
    let p = -1;
    at = recs.map((r, k) => {
      const prev = recs[k - 1];
      const restart = parseStep(r, k).todo !== undefined && (p + 1 >= steps.length || (prev !== undefined && !prev.ok));
      p = restart ? 0 : p + 1;
      return steps[p]?.kind === r.kind ? p : -1;
    });
  }
  if (at.includes(-1) || (recs.length > 0 && at[0] !== 0)) return "drift";

  // The edge the runner followed out of a recorded step: a route's chosen path (or otherwise when
  // nothing matched), a gate's fail/loop on FAIL, else the step's forward edge. Into a group, that
  // edge is a `fork` that keeps its kind in `via`.
  const out = (k: number): number => {
    const r = recs[k]!;
    const from = at[k]!;
    const want = (e: FlowEdge): boolean => {
      const kind = e.kind === "fork" ? e.via : e.kind;
      return steps[from]!.route ? (r.chose !== undefined ? kind === "path" && e.label === r.chose : kind === "otherwise")
        : steps[from]!.gate && r.verdict === "FAIL" ? kind === "fail" || kind === "loop"
        : kind === "flow" || kind === "next" || kind === "pass";
    };
    return edges.findIndex((e) => e.from === from && want(e));
  };
  const groups = new Map(stepGroups(steps).map((g) => [g.first, g] as const));
  const counts = steps.map(() => 0);
  const failed = steps.map(() => false);
  const errored = new Set<number>(); // errored as of an earlier pass
  const pass = new Map<number, boolean>(); // this pass: step → its latest attempt errored
  const lit = new Set<number>();
  const mark = (k: number): void => {
    const i = at[k]!;
    counts[i]!++;
    pass.set(i, !recs[k]!.ok);
    failed[i] = errored.has(i) || !stepPassed(recs[k]!);
  };
  // No next record, or the next one starts a new todo pass — which closes this pass. Called once per record.
  const passEnds = (k: number): boolean => {
    const next = recs[k + 1];
    const ends = !next || (at[k + 1] === 0 && !(next.round && next.round > 1));
    if (ends) {
      for (const [i, err] of pass) if (err) errored.add(i);
      pass.clear();
    }
    return ends;
  };
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k]!;
    const g = groups.get(at[k]!);
    if (g) {
      const last = k + g.last - g.first;
      for (let j = k; j <= last; j++) {
        if (at[j] !== g.first + j - k) return "drift"; // not the whole group, in step order
        mark(j);
      }
      // Every member joins at the same place.
      const joins = edges.flatMap((e, x) => (e.kind === "join" && e.from >= g.first && e.from <= g.last ? [x] : []));
      const to = edges[joins[0]!]?.to;
      if (!passEnds(last)) {
        if (to !== at[last + 1]) return "drift";
        joins.forEach((x) => lit.add(x));
      } else if (typeof to !== "number") joins.forEach((x) => lit.add(x)); // the group ended the run
      k = last;
      continue;
    }
    mark(k);
    const e = out(k);
    if (!passEnds(k)) {
      // A hop with no matching edge today: the sprout was re-pointed since this run.
      if (e < 0 || edges[e]!.to !== at[k + 1]) return "drift";
      const hop = edges[e]!;
      // Into a group: the fork to every member, not just the first.
      edges.forEach((f, x) => { if (x === e || (hop.kind === "fork" && f.kind === "fork" && f.from === hop.from && f.via === hop.via && f.label === hop.label)) lit.add(x); });
    } else if (r.ok) {
      if (e < 0) return "drift"; // e.g. the route label it chose is gone
      if (typeof edges[e]!.to !== "number") lit.add(e); // ended at ● end or ■ stop
    }
  }
  return { counts, failed, edges: lit };
}

/** Where one step attempt sits among a run's agent sessions (see attemptSessions). */
export interface AttemptSession {
  /** Step number of the session's first attempt — set only on a session more than one attempt shares. */
  session?: number;
  /** The session's latest attempt; also any attempt whose session is unknown or its own. */
  last: boolean;
  /** Index of the session's next attempt, on every attempt but its last. */
  next?: number;
  /** It was meant to continue another step's session but started a new one. */
  fresh?: true;
}

type SessionAttempt = Pick<StepAttemptView, "stepIndex" | "resume" | "output">;

/** The runner's note on a step whose `continues` target left no session (routine-runner.ts). */
const FRESH_NOTE = "(No earlier session from ";

/** Which attempts of one run were one agent session. `resume` is built only from the session id,
 * so equal strings are the same session; that is all grouping reads, so editing the sprout later
 * can't regroup a past run. An attempt with no `resume` is never grouped. `fresh` is the runner's
 * own note when it's still there (outputs are tail-capped), else what `steps` says: the step
 * continues another, yet its session starts here. Pure. */
export function attemptSessions(attempts: readonly SessionAttempt[], steps: readonly RoutineStep[] = []): AttemptSession[] {
  return attempts.map((a, i) => {
    const same = (b: SessionAttempt): boolean => a.resume !== undefined && b.resume === a.resume;
    const first = attempts.findIndex(same);
    const next = attempts.findIndex((b, j) => j > i && same(b));
    const shared = first >= 0 && (first !== i || next >= 0);
    const fresh = a.output.startsWith(FRESH_NOTE) || (first === i && steps[a.stepIndex]?.continues !== undefined);
    return {
      ...(shared ? { session: attempts[first]!.stepIndex + 1 } : {}),
      last: next < 0, ...(next >= 0 ? { next } : {}), ...(fresh ? { fresh: true as const } : {}),
    };
  });
}

/** One line over a run's full output when any session was shared:
 * `2 agent sessions · ↻2 steps 2→4→6 (opencode) · ↻3 steps 3→5 (claude)`. */
export function sessionSummary(attempts: readonly (SessionAttempt & { cli?: string })[]): string | undefined {
  const sessions = new Map<string, number[]>();
  attempts.forEach((a, i) => { if (a.resume !== undefined) sessions.set(a.resume, [...(sessions.get(a.resume) ?? []), i]); });
  const shared = [...sessions.values()].filter((l) => l.length > 1);
  if (shared.length === 0) return undefined;
  const lane = (l: number[]): string => {
    const nums = l.map((i) => attempts[i]!.stepIndex + 1).filter((n, k, all) => n !== all[k - 1]);
    const cli = attempts[l[0]!]!.cli;
    return `↻${nums[0]} steps ${nums.join("→")}${cli ? ` (${cli})` : ""}`;
  };
  return [`${sessions.size} agent session${sessions.size === 1 ? "" : "s"}`, ...shared.map(lane)].join(" · ");
}

/** StepFlow's `lanes` for a past run, from what its attempts actually shared rather than today's
 * `continues`: each step → the first step of the session its first shared attempt was in. */
export function observedLanes(attempts: readonly SessionAttempt[], stepCount: number): number[] {
  const lanes = Array.from({ length: stepCount }, (_, k) => k);
  const done = new Set<number>();
  attemptSessions(attempts).forEach(({ session }, i) => {
    const k = attempts[i]!.stepIndex;
    if (session === undefined || k >= stepCount || done.has(k)) return;
    lanes[k] = session - 1;
    done.add(k);
  });
  return lanes;
}

/** A gate stopped (or exhausted) this run: where it stopped and the verdict it stopped on — the
 * last step that didn't pass (a later todo pass may have succeeded after it). */
export function attentionOf(run: Pick<RunRecord, "status" | "steps">): { at: string; verdict?: string; summary: string } | undefined {
  if (run.status !== "needs-attention") return undefined;
  const index = run.steps.findLastIndex((s) => !stepPassed(s));
  if (index < 0) return { at: "an unknown step", summary: "" };
  const step = parseStep(run.steps[index]!, index);
  return { at: pathName(step), summary: step.summary, ...(step.verdict ? { verdict: step.verdict } : {}) };
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
      runs.push({ ...record, routine, id: runId(routine, record.startedAt), ...(record.id ? { recordId: record.id } : {}) });
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A failed step is the only thing in a run that can actually need a decision; everything
 * else resolved without you and collapses to one line. A step's latest attempt decides: a failure
 * that a later attempt of the same step (same todo) got past — a group member retried on a loop —
 * resolved, and nothing in an `ok` run needs you. */
export function splitSteps(run: DashRun | undefined): { needs: DashStep[]; resolved: DashStep[] } {
  const steps: DashStep[] = (run?.steps ?? []).map(parseStep);
  const needsYou = (s: DashStep, k: number): boolean => !s.ok && run?.status !== "ok" &&
    !(s.id !== undefined && steps.slice(k + 1).some((t) => t.id === s.id && t.todo === s.todo && t.ok));
  return { needs: steps.filter(needsYou), resolved: steps.filter((s, k) => !needsYou(s, k)) };
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
  /** Runs a gate stopped (status needs-attention). */
  attention: number;
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

/** The bucket a run lands in: its routine on the run's local day. */
export const bucketKeyFor = (routine: string, startedAt: string): string => bucketKey(localDate(startedAt), routine);

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
      bucket = { key, routine: run.routine, date, runs: [], needs: 0, attention: 0 };
      byBucket.set(key, bucket);
      day.buckets.push(bucket);
    }
    bucket.runs.push(run);
    const failed = splitSteps(run).needs.length;
    bucket.needs += failed;
    if (run.status === "needs-attention") bucket.attention++;
    day.runCount++;
    day.needs += failed;
  }
  return days;
}
