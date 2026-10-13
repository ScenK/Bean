import type { AvailableModel, CliName, RoutineStep } from "@bean/core";
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

/** Enable-time check: one line per delegate step whose pinned harness/model can't run here,
 * so an unattended 03:00 run isn't the first to find out. */
export function stepProblemsText(steps: RoutineStep[], clis: CliName[], models: AvailableModel[]): string {
  return steps.flatMap((s, i) => {
    const problem = s.kind === "delegate" ? stepAvailabilityProblem(s, clis, models) : undefined;
    return problem ? [`step ${i + 1}: ${problem}`] : [];
  }).join("; ");
}
