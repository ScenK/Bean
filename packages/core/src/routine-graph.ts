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

/** A parallel group's size cap. `MAX_PARALLEL` (same value) lives in the Node-only store. */
export const MAX_GROUP = 4;

export interface StepGroup { first: number; last: number }

/** Each parallel group's first..last step index: a step plus the run of `alongside: true` steps
 * right below it. Step 1's own `alongside` starts nothing (it's rejected). */
export function stepGroups(steps: readonly { alongside?: unknown }[]): StepGroup[] {
  const groups: StepGroup[] = [];
  steps.forEach((s, i) => {
    if (i === 0 || s.alongside !== true) return;
    const g = groups[groups.length - 1];
    if (g && g.last === i - 1) g.last = i;
    else groups.push({ first: i - 1, last: i });
  });
  return groups;
}

/** The parallel-group rules per step (null = fine). They need the whole list — membership, group
 * size, edges into a group — so they sit beside `describeEdgeError`, which sees one step. */
export function describeGroupErrors(steps: readonly Record<string, unknown>[], ids: Map<string, number>): (string | null)[] {
  const out: (string | null)[] = steps.map((s, i) =>
    s.alongside === undefined || s.alongside === true ? null : `step ${i + 1}: alongside must be true when present`);
  if (steps[0]?.alongside === true) out[0] = "step 1 can't run alongside — there's no step above it";
  const groups = stepGroups(steps);
  const groupOf = new Map<number, StepGroup>();
  for (const g of groups) {
    for (let k = g.first; k <= g.last; k++) groupOf.set(k, g);
    if (g.last - g.first >= MAX_GROUP) {
      out[g.first + MAX_GROUP] ??= `step ${g.first + MAX_GROUP + 1}: a group runs at most ${MAX_GROUP} steps — steps ${g.first + 1}–${g.first + MAX_GROUP} already run together`;
    }
  }
  steps.forEach((s, i) => {
    const g = groupOf.get(i);
    if (g && (s.gate !== undefined || s.next !== undefined || s.route !== undefined)) {
      out[i] ??= i === g.first
        ? `step ${i + 1}: step ${i + 2} runs alongside it, so it can't have a gate, next or route`
        : `step ${i + 1} runs alongside step ${g.first + 1}, so it can't have a gate, next or route`;
    }
    // Only a group's first member may be a target: entering mid-group would skip its siblings.
    const into = (v: unknown, what: string): void => {
      const t = str(v) && v !== "end" ? ids.get(v) : undefined;
      const tg = t === undefined ? undefined : groupOf.get(t);
      if (tg && t !== tg.first) out[i] ??= `step ${i + 1}: ${what} can't point into a group — point it at step ${tg.first + 1}, where the group starts`;
    };
    into(s.next, "next");
    const onFail = (s.gate as { onFail?: unknown } | null | undefined)?.onFail;
    if (typeof onFail === "object" && onFail !== null) into((onFail as { goto?: unknown }).goto, "gate goto");
    const route = (typeof s.route === "object" && s.route !== null ? s.route : {}) as { paths?: unknown; otherwise?: unknown };
    if (Array.isArray(route.paths)) {
      for (const p of route.paths) {
        const { when, goto } = (typeof p === "object" && p !== null ? p : {}) as { when?: unknown; goto?: unknown };
        into(goto, `route "${String(when)}"`);
      }
    }
    into(route.otherwise, "route otherwise");
  });
  // Members can't carry `next`, so a group ending a route path would run on into a sibling path.
  walkRoutePaths(steps as unknown as RoutineStep[], (path, cur, from) => {
    const g = groupOf.get(from);
    const sibling = path.entries.get(cur);
    if (!g || from !== g.last || cur !== g.last + 1 || cur === path.entry || sibling === undefined) return;
    out[from] ??= `step ${from + 1}: path '${path.label}' ends in a group that runs on into path '${sibling}' — add a step after the group with next: end`;
  });
  return out;
}

/** First index per step id. */
const stepIds = (steps: readonly { id?: string }[]): Map<string, number> => {
  const ids = new Map<string, number>();
  steps.forEach((s, i) => { if (s.id && !ids.has(s.id)) ids.set(s.id, i); });
  return ids;
};

/** Each step's session lane: the index of the step whose session it ultimately continues
 * (itself when it continues nothing). A `continues` that names no earlier step starts its own
 * lane — the validator reports it. */
export function stepLanes(steps: readonly { id?: unknown; continues?: unknown }[]): number[] {
  const ids = new Map<unknown, number>();
  const lanes: number[] = [];
  steps.forEach((s, i) => {
    const t = s.continues === undefined ? undefined : ids.get(s.continues);
    lanes.push(t === undefined ? i : lanes[t]!);
    if (s.id !== undefined && !ids.has(s.id)) ids.set(s.id, i);
  });
  return lanes;
}

/** Why step `i` can't continue step `t`'s session (null = it can). One wording for the save
 * check, the editor's alert and its target picker. */
function continueProblem(steps: readonly Record<string, unknown>[], i: number, t: number, lanes: number[], groups: StepGroup[]): string | null {
  const at = `step ${i + 1}`;
  const s = steps[i]!, target = steps[t]!;
  if (t === i) return `${at} can't continue its own session — a gate loop already resumes it`;
  if (t > i) return `${at}: continues must point to an earlier step`;
  if (target.kind !== "delegate") return `${at}: step ${t + 1} is a ${String(target.kind)} step — only a delegate step's session can be continued`;
  if (s.cli === undefined || target.cli === undefined) return `${at}: pin the same coding agent on this step and step ${t + 1} to continue its session`;
  if (s.cli !== target.cli) return `${at}: step ${t + 1} runs on ${String(target.cli)}, this step on ${String(s.cli)} — a session only continues on the same coding agent`;
  if ((s.project ?? "") !== (target.project ?? "")) return `${at}: step ${t + 1} works in a different project — a session only continues in the same project`;
  const g = groups.find((x) => i >= x.first && i <= x.last);
  if (g && t >= g.first) return `${at} runs alongside step ${t + 1}, so it can't continue its session`;
  // Members run at once: two of them on one lane would resume the same session concurrently.
  for (let k = g?.first ?? i; k < i; k++) {
    if (lanes[k] === lanes[t]) return `${at}: step ${k + 1} runs alongside it in the same session — a group's steps can't share one`;
  }
  return null;
}

/** The `continues` rules per step (null = fine): an earlier delegate target on the same `cli`
 * and `project`, not a sibling in its group, and no two group members on one lane. */
export function describeContinueErrors(steps: readonly Record<string, unknown>[], ids: Map<string, number>): (string | null)[] {
  const lanes = stepLanes(steps);
  const groups = stepGroups(steps);
  return steps.map((s, i) => {
    if (!str(s.continues)) return null;
    const t = ids.get(s.continues);
    if (t === undefined) return `step ${i + 1}: continues step "${s.continues}" doesn't exist`;
    return continueProblem(steps, i, t, lanes, groups);
  });
}

/** Every earlier delegate step step `i` could continue, each with the problem continuing it
 * would have (null = fine) — the editor's target picker. Render-only. */
export function continueTargets(steps: RoutineStep[], i: number): { index: number; id?: string; problem: string | null }[] {
  const raw = steps as unknown as Record<string, unknown>[];
  const lanes = stepLanes(steps);
  const groups = stepGroups(steps);
  return steps.slice(0, i).flatMap((s, t) => s.kind !== "delegate" ? [] : [{
    index: t, ...(s.id ? { id: s.id } : {}), problem: continueProblem(raw, i, t, lanes, groups),
  }]);
}

/** Render-only captions per step: a lane's first step says where its session continues
 * ("its session continues in steps 4, 6"), a continuing step names the step it resumes. A
 * rejected `continues` gets no caption — its problem shows instead. */
export function stepContinueCaptions(steps: RoutineStep[]): (string | null)[] {
  const ids = stepIds(steps);
  const problems = describeContinueErrors(steps as unknown as Record<string, unknown>[], ids);
  const valid = steps.map((s, i) => (problems[i] ? { ...s, continues: undefined } : s));
  const lanes = stepLanes(valid);
  return valid.map((s, i) => {
    if (s.continues !== undefined) return `continues step ${ids.get(s.continues)! + 1}'s session`;
    const later = lanes.flatMap((root, k) => (root === i && k !== i ? [k + 1] : []));
    return later.length ? `its session continues in step${later.length > 1 ? "s" : ""} ${later.join(", ")}` : null;
  });
}

/** Each step's edge problem (or null) against the steps' current order — what a reorder or a
 * delete broke, before save. */
export function stepEdgeProblems(steps: RoutineStep[]): (string | null)[] {
  const ids = stepIds(steps);
  const raw = steps as unknown as Record<string, unknown>[];
  const groups = describeGroupErrors(raw, ids);
  const continues = describeContinueErrors(raw, ids);
  return raw.map((s, i) => describeEdgeError(s, i, ids) ?? groups[i] ?? continues[i] ?? null);
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
    // `?.`: the save check walks hand-edited JSON before any route shape is checked.
    const targets = [...s.route.paths.map((p) => [p?.when || "…", p?.goto] as const), ...(s.route.otherwise ? [["otherwise", s.route.otherwise] as const] : [])]
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
 * tail with no `next` that falls through into a sibling path's entry step. A group member can't
 * set `next` — `describeGroupErrors` blocks that case instead. */
export function stepEdgeWarnings(steps: RoutineStep[]): (string | null)[] {
  const out: (string | null)[] = steps.map(() => null);
  const groups = stepGroups(steps);
  walkRoutePaths(steps, (path, cur, from, viaNext) => {
    const into = path.entries.get(cur);
    if (viaNext || cur === path.entry || into === undefined || out[from]) return;
    if (groups.some((g) => from >= g.first && from <= g.last)) return;
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

/** The editor's caption per step for parallel groups (null = not in or after one): the first
 * member says how big the group is and where it joins, other members name it, the join step says
 * what it waits for. A step that both joins one group and starts the next gets both. */
export function stepGroupCaptions(steps: readonly { alongside?: unknown }[]): (string | null)[] {
  const out: (string | null)[] = steps.map(() => null);
  const add = (i: number, text: string): void => { out[i] = out[i] ? `${out[i]} · ${text}` : text; };
  for (const g of stepGroups(steps)) {
    const join = g.last + 1 < steps.length ? `joins at ${g.last + 2}` : "joins at end";
    add(g.first, `starts a group of ${g.last - g.first + 1} · ${join}`);
    for (let k = g.first + 1; k <= g.last; k++) add(k, `runs alongside ${g.first + 1}`);
    if (g.last + 1 < steps.length) add(g.last + 1, `waits for steps ${g.first + 1}–${g.last + 1}`);
  }
  return out;
}

/** One edge of the read-only flow picture. `to` is a step index, or the run ending ok (`end`) /
 * asking for you (`stop`). `fail` goes forward, `loop` back (with its round cap); a route's
 * no-match is `otherwise` → `stop`. A forward edge into a parallel group becomes one `fork` per
 * member (`via` keeps the incoming kind, `label` its label); each member has one `join` edge to
 * the step after the group (or `end`). */
export interface FlowEdge {
  from: number;
  to: number | "end" | "stop";
  kind: "flow" | "next" | "pass" | "fail" | "loop" | "path" | "otherwise" | "fork" | "join";
  via?: Exclude<FlowEdge["kind"], "fork" | "join" | "loop">;
  label?: string;
  maxRounds?: number;
}
export interface FlowNode { key: string; index: number; id?: string; kind: RoutineStep["kind"]; flagged: boolean }

/** The steps as a graph for the editor's diagram — the same edges the runner follows. Never
 * assigns ids and never throws on a half-edited draft: an edge `stepEdgeProblems` rejects is
 * left out and its step flagged, so the picture never contradicts the card's alert. Render-only. */
export function stepFlow(steps: RoutineStep[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const ids = new Map<string, number>();
  steps.forEach((s, i) => { if (s.id && !ids.has(s.id)) ids.set(s.id, i); });
  const at = (goto: string): number | "end" => (goto === "end" ? "end" : ids.get(goto)!);
  const broken = (s: unknown, i: number): boolean => describeEdgeError(s as Record<string, unknown>, i, ids) !== null;
  const problems = stepEdgeProblems(steps);
  const groupOf = new Map<number, StepGroup>();
  for (const g of stepGroups(steps)) for (let k = g.first; k <= g.last; k++) groupOf.set(k, g);
  const edges: FlowEdge[] = [];
  const push = (e: FlowEdge): void => {
    const g = typeof e.to === "number" ? groupOf.get(e.to) : undefined;
    // An edge into a member past the first is rejected (its step is flagged); a loop stays one lane.
    if (g && e.to !== g.first) return;
    if (!g || e.kind === "loop") { edges.push(e); return; }
    for (let m = g.first; m <= g.last; m++) {
      edges.push(e.kind === "join" ? { ...e, to: m } : { ...e, to: m, kind: "fork", via: e.kind as NonNullable<FlowEdge["via"]> });
    }
  };
  const nodes = steps.map((s, i): FlowNode => {
    const flagged = problems[i] !== null;
    const group = groupOf.get(i);
    if (group) {
      // A member's own gate/next/route is rejected, so it only joins.
      push({ from: i, to: group.last + 1 < steps.length ? group.last + 1 : "end", kind: "join" });
    } else if (s.route) {
      // A route with any bad path (or a gate/next beside it) is dropped whole, like at save.
      if (!flagged) {
        // By index, not label: a path may be labelled "otherwise".
        for (const p of s.route.paths) push({ from: i, to: at(p.goto), kind: "path", label: p.when });
        push({ from: i, to: s.route.otherwise === undefined ? "stop" : at(s.route.otherwise), kind: "otherwise" });
      }
    } else {
      if (!broken({ next: s.next }, i)) {
        const to = s.next !== undefined ? at(s.next) : i + 1 < steps.length ? i + 1 : "end";
        push({ from: i, to, kind: s.gate ? "pass" : s.next !== undefined ? "next" : "flow" });
      }
      const onFail = s.gate?.onFail;
      if (onFail !== undefined && !broken({ gate: s.gate }, i)) {
        if (onFail === "stop") push({ from: i, to: "stop", kind: "fail" });
        else {
          const to = ids.get(onFail.goto)!;
          push(to > i ? { from: i, to, kind: "fail" } : { from: i, to, kind: "loop", maxRounds: onFail.maxRounds ?? DEFAULT_GATE_ROUNDS });
        }
      }
    }
    return { key: `${i}:${s.id ?? ""}`, index: i, ...(s.id ? { id: s.id } : {}), kind: s.kind, flagged };
  });
  return { nodes, edges };
}
