// Node-free (renderer-safe, `@bean/core/routine-graph`): the step-graph edge rules, shared by the
// save-time validator and the editor's inline checks so both say exactly the same thing.
import type { RoutineStep } from "./routine-store.js";

export const DEFAULT_GATE_ROUNDS = 3;
export const MAX_GATE_ROUNDS = 5;

const str = (v: unknown): v is string => typeof v === "string";

export const ROUTE_LABEL_RE = /^[a-z0-9-]+$/;

/** Route checks: ≥2 paths, unique labels, every target a later step or "end". */
function describeRouteError(route: unknown, at: string, i: number, ids: Map<string, number>): string | null {
  const { paths, otherwise } = (typeof route === "object" && route !== null ? route : {}) as { paths?: unknown; otherwise?: unknown };
  if (!Array.isArray(paths) || paths.length < 2) return `${at}: a route needs at least 2 paths`;
  const forward = (v: unknown, what: string): string | null => {
    if (v === "end") return null;
    if (!str(v)) return `${at}: ${what} needs a step id or "end"`;
    const target = ids.get(v);
    if (target === undefined) return `${at}: ${what} step "${v}" doesn't exist`;
    return target <= i ? `${at}: ${what} must point to a later step (or "end")` : null;
  };
  const seen = new Set<string>();
  for (const p of paths) {
    const { when, goto } = (typeof p === "object" && p !== null ? p : {}) as { when?: unknown; goto?: unknown };
    if (!str(when) || !ROUTE_LABEL_RE.test(when)) return `${at}: each route label must use a-z, 0-9, "-"`;
    // A gate's words would read as a verdict, not a choice.
    if (when === "pass" || when === "fail") return `${at}: "${when}" can't be a route label — use a gate for pass/fail`;
    if (seen.has(when)) return `${at}: route label "${when}" is used twice`;
    seen.add(when);
    const err = forward(goto, `route "${when}"`);
    if (err) return err;
  }
  return otherwise === undefined ? null : forward(otherwise, "route otherwise");
}

/** Gate/next/route checks. Only a gated backward goto can make a cycle: `next` and routes are
 * forward-only. */
export function describeEdgeError(s: Record<string, unknown>, i: number, ids: Map<string, number>): string | null {
  const at = `step ${i + 1}`;
  if (s.route !== undefined) {
    if (s.gate !== undefined || s.next !== undefined) return `${at}: a route can't be combined with a gate or next`;
    return describeRouteError(s.route, at, i, ids);
  }
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
