// Node-free (renderer-safe, `@bean/core/routine-graph`): the step-graph edge rules, shared by the
// save-time validator and the editor's inline checks so both say exactly the same thing.
import type { RoutineStep } from "./routine-store.js";

export const DEFAULT_GATE_ROUNDS = 3;
export const MAX_GATE_ROUNDS = 5;

const str = (v: unknown): v is string => typeof v === "string";

/** Gate/next checks. Only a gated backward goto can make a cycle: `next` is forward-only. */
export function describeEdgeError(s: Record<string, unknown>, i: number, ids: Map<string, number>): string | null {
  const at = `step ${i + 1}`;
  if (s.next !== undefined && s.next !== "end") {
    if (!str(s.next)) return `${at} has an invalid next step`;
    const target = ids.get(s.next);
    if (target === undefined) return `${at}: next step "${s.next}" doesn't exist`;
    if (target <= i) return `${at}: next must point to a later step (or "end") — loop back with a gate instead`;
  }
  if (s.gate === undefined) return null;
  const onFail = (s.gate as { onFail?: unknown } | null)?.onFail;
  if (onFail === "stop") return null;
  if (typeof onFail !== "object" || onFail === null) return `${at}: gate.onFail must be "stop" or { "goto": "<step id>" }`;
  const { goto, maxRounds } = onFail as { goto?: unknown; maxRounds?: unknown };
  if (!str(goto)) return `${at}: gate.onFail needs a goto step id`;
  const target = ids.get(goto);
  if (target === undefined) return `${at}: gate goto step "${goto}" doesn't exist`;
  if (target === i) return `${at}: a gate can't goto its own step`;
  if (target > i) return maxRounds === undefined ? null : `${at}: maxRounds only applies to a loop (a goto to an earlier step)`;
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || (maxRounds as number) < 1 || (maxRounds as number) > MAX_GATE_ROUNDS)) {
    return `${at}: maxRounds must be a whole number from 1 to ${MAX_GATE_ROUNDS}`;
  }
  return null;
}

/** Each step's edge problem (or null) against the steps' current order — what a reorder or a
 * delete broke, before save. */
export function stepEdgeProblems(steps: RoutineStep[]): (string | null)[] {
  const ids = new Map<string, number>();
  steps.forEach((s, i) => { if (s.id && !ids.has(s.id)) ids.set(s.id, i); });
  return steps.map((s, i) => describeEdgeError(s as unknown as Record<string, unknown>, i, ids));
}
