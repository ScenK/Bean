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

/** Walks every route path forward from its entry the way the runner would on success: `next`
 * jumps, otherwise the following step; stops at a nested route, `next: "end"`, or the last step.
 * `visit` sees each step reached, the step it came from, and whether a `next` led there. Render-only. */
function walkRoutePaths(
  steps: RoutineStep[],
  visit: (path: { key: string; label: string; entry: number; entries: Map<number, string> }, cur: number, from: number, viaNext: boolean) => void,
  ends?: (cur: number) => void,
): void {
  const ids = new Map<string, number>();
  steps.forEach((s, i) => { if (s.id && !ids.has(s.id)) ids.set(s.id, i); });
  steps.forEach((s, r) => {
    if (!s.route || !Array.isArray(s.route.paths)) return;
    const targets = [...s.route.paths.map((p) => [p.when || "…", p.goto] as const), ...(s.route.otherwise ? [["otherwise", s.route.otherwise] as const] : [])]
      // "end" is the sentinel even if a step happens to have that id; the key tells a path labeled
      // "otherwise" apart from the fallback.
      .flatMap(([label, goto], k) => { const entry = goto === "end" ? undefined : ids.get(goto); return entry !== undefined && entry > r ? [{ key: `${r}:${k}`, label, entry }] : []; });
    // Entry step → the first path that starts there.
    const entries = new Map<number, string>();
    for (const t of targets) if (!entries.has(t.entry)) entries.set(t.entry, t.label);
    for (const { key, label, entry } of targets) {
      const path = { key, label, entry, entries };
      let cur = entry, from = r, viaNext = true;
      // Forward-only edges, so every hop moves down: the walk ends within steps.length hops.
      while (cur > from) {
        visit(path, cur, from, viaNext);
        const step = steps[cur]!;
        if (step.route) break;
        if (step.next === "end" || (step.next === undefined && cur === steps.length - 1)) { ends?.(cur); break; }
        from = cur;
        viaNext = step.next !== undefined;
        cur = step.next === undefined ? cur + 1 : (ids.get(step.next) ?? -1);
      }
    }
  });
}

/** Non-blocking hints per step (never in `stepEdgeProblems`, which drops/blocks edges): a path's
 * tail with no `next` that falls through into a sibling path's entry step. */
export function stepEdgeWarnings(steps: RoutineStep[]): (string | null)[] {
  const out: (string | null)[] = steps.map(() => null);
  walkRoutePaths(steps, (path, cur, from, viaNext) => {
    const into = path.entries.get(cur);
    if (viaNext || cur === path.entry || into === undefined || out[from]) return;
    out[from] = `path '${path.label}' runs on into path '${into}' — set then → … or end`;
  });
  return out;
}

/** Render-only captions per step: `on path · <label>`, `paths rejoin here` where paths arriving
 * from different steps meet, plus `· ends the run` on a path's last step. */
export function stepPathCaptions(steps: RoutineStep[]): (string | null)[] {
  // Per step: path key → [label, the step it arrived from].
  const reached = steps.map(() => new Map<string, [string, number]>());
  const ending = new Set<number>();
  walkRoutePaths(steps, (path, cur, from) => { reached[cur]!.set(path.key, [path.label, from]); }, (cur) => ending.add(cur));
  return reached.map((paths, i) => {
    const arrivals = [...paths.values()];
    const caption = arrivals.length === 1 ? `on path · ${arrivals[0]![0]}`
      : new Set(arrivals.map(([, from]) => from)).size > 1 ? "paths rejoin here" : null;
    return caption && ending.has(i) ? `${caption} · ends the run` : caption;
  });
}
