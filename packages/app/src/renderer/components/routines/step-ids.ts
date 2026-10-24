import type { AvailableModel, CliName, RoutineStep, StepRoute } from "@bean/core";
import { stepAvailabilityProblem } from "@bean/core/models";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";

/** Gives every id-less step a stable id (`<skill slug>-<n>`, or `<kind>-<n>`) unique within the
 * routine; steps that already have one keep it, so ids survive reorder/delete/kind changes.
 * Called only on an edit — an untouched legacy routine saves back byte-for-byte. */
export function withStepIds(steps: RoutineStep[]): RoutineStep[] {
  const used = new Set(steps.flatMap((s) => (s.id ? [s.id] : [])));
  return steps.map((s) => {
    if (s.id) return s;
    const base = slug(s.skill || s.kind);
    let n = 1;
    while (used.has(`${base}-${n}`)) n++;
    used.add(`${base}-${n}`);
    return { ...s, id: `${base}-${n}` };
  });
}

/** Inserts an exact copy of step `i` (every field, `gate`/`next` included) directly below it,
 * with a fresh id. Below keeps every edge's direction, so the copy never raises an edge problem. */
export function duplicateStep(steps: RoutineStep[], i: number): RoutineStep[] {
  const withIds = withStepIds(steps);
  const original = withIds[i];
  if (!original) return withIds;
  const { id: _id, ...copy } = structuredClone(original);
  return withStepIds([...withIds.slice(0, i + 1), copy as RoutineStep, ...withIds.slice(i + 1)]);
}

/** Points step `i`'s success edge at step `target` (by its id), at `"end"`, or clears it
 * (`undefined` = run the following step). Ids are assigned first so the edge has a target. */
export function setStepNext(steps: RoutineStep[], i: number, target: number | "end" | undefined): RoutineStep[] {
  const withIds = withStepIds(steps);
  const next = target === "end" ? "end" : target === undefined ? undefined : withIds[target]?.id;
  return withIds.map((s, j) => {
    if (j !== i) return s;
    const { next: _old, ...rest } = s;
    return (next ? { ...rest, next } : rest) as RoutineStep;
  });
}

/** Moves the builder's `steps.<i>…` questions with their step (matched by id) across an
 * insert/remove/reorder. A question is dropped once its step is gone or its step changed
 * (editing a step answers it); non-step fields pass through. */
export function remapStepMissing<M extends { field: string }>(missing: M[], before: RoutineStep[], after: RoutineStep[]): M[] {
  const index = new Map<string, number>();
  after.forEach((s, i) => { if (s.id && !index.has(s.id)) index.set(s.id, i); });
  return missing.flatMap((m) => {
    const match = /^steps\.(\d+)(\..*)?$/.exec(m.field);
    if (!match) return [m];
    const old = before[Number(match[1])];
    const to = old?.id === undefined ? undefined : index.get(old.id);
    if (to === undefined || JSON.stringify(after[to]) !== JSON.stringify(old)) return [];
    return [{ ...m, field: `steps.${to}${match[2] ?? ""}` }];
  });
}

/** Enable-time check: one line per delegate step whose pinned harness/model can't run here,
 * so an unattended 03:00 run isn't the first to find out. */
export function stepProblemsText(steps: RoutineStep[], clis: CliName[], models: AvailableModel[]): string {
  return steps.flatMap((s, i) => {
    const problem = s.kind === "delegate" ? stepAvailabilityProblem(s, clis, models) : undefined;
    return problem ? [`step ${i + 1}: ${problem}`] : [];
  }).join("; ");
}

/** Sets step `i`'s route (or clears it), dropping its gate and `next` — a route replaces both.
 * Ids are assigned first so path targets picked by index have an id to point at. */
export function setStepRoute(steps: RoutineStep[], i: number, route: StepRoute | undefined): RoutineStep[] {
  return withStepIds(steps).map((s, j) => {
    if (j !== i) return s;
    const { route: _route, ...rest } = s;
    if (!route) return rest as RoutineStep;
    const { gate: _gate, next: _next, ...plain } = rest;
    return { ...plain, route } as RoutineStep;
  });
}
