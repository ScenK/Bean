import { describe, expect, it } from "vitest";
import type { RoutineStep } from "../src/routine-store.js";
import { stepEdgeProblems, stepEdgeWarnings, stepFlow, stepPathCaptions } from "../src/routine-graph.js";

const s = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep => ({ kind: "chat", id, instruction: "x", ...extra } as RoutineStep);
const route = (bug: string, spec: string, reply: string, otherwise?: string): Partial<RoutineStep> =>
  ({ route: { paths: [{ when: "bug", goto: bug }, { when: "spec", goto: spec }, { when: "reply", goto: reply }], ...(otherwise ? { otherwise } : {}) } });

// The motivating triage: classify → bug | spec | reply, then a shared report.
const triage = (over: Record<string, Partial<RoutineStep>> = {}): RoutineStep[] => [
  s("classify", route("bug", "spec", "reply")),
  s("bug", { next: "report", ...over.bug }),
  s("spec", { next: "report", ...over.spec }),
  s("reply", over.reply),
  s("report", over.report),
];

describe("stepEdgeWarnings", () => {
  it("stays quiet on the triage: explicit then, and the last path falling into the rejoin", () => {
    const steps = triage();
    expect(stepEdgeProblems(steps)).toEqual([null, null, null, null, null]);
    expect(stepEdgeWarnings(steps)).toEqual([null, null, null, null, null]);
  });

  it("warns when a path's tail runs on into a sibling path's entry", () => {
    const steps = triage({ bug: { next: undefined } });
    expect(stepEdgeWarnings(steps)).toEqual([null, "path 'bug' runs on into path 'spec' — set then → … or end", null, null, null]);
  });

  it("warns on the tail of a multi-step path, not the entry", () => {
    const steps = [s("d", route("a1", "b", "end")), s("a1"), s("a2"), s("b")];
    expect(stepEdgeWarnings(steps)).toEqual([null, null, "path 'bug' runs on into path 'spec' — set then → … or end", null]);
  });

  it("stays quiet on goto end, a tail then → end, a tail then → step, and the last step", () => {
    expect(stepEdgeWarnings([s("d", route("end", "b", "c")), s("b", { next: "end" }), s("c")]).every((w) => w === null)).toBe(true);
    expect(stepEdgeWarnings([s("d", route("a", "b", "end")), s("a", { next: "c" }), s("b"), s("c")]).every((w) => w === null)).toBe(true);
  });

  it("counts otherwise as a path", () => {
    const steps = [s("d", route("end", "end", "end", "o")), s("o"), s("b")];
    expect(stepEdgeWarnings(steps)).toEqual([null, null, null]);
    const into = [s("d", route("b", "end", "end", "o")), s("o"), s("b")];
    expect(stepEdgeWarnings(into)).toEqual([null, "path 'otherwise' runs on into path 'bug' — set then → … or end", null]);
  });

  it("is empty without routes and survives a dangling target", () => {
    expect(stepEdgeWarnings([s("a"), s("b")])).toEqual([null, null]);
    expect(stepEdgeWarnings([s("d", route("gone", "b", "end")), s("b")])).toEqual([null, null]);
  });
});

describe("stepPathCaptions", () => {
  it("labels each path, marks the rejoin, and the run's end", () => {
    expect(stepPathCaptions(triage())).toEqual([
      null, "on path · bug", "on path · spec", "on path · reply", "paths rejoin here · ends the run",
    ]);
  });

  it("marks a path that ends the run itself, and skips steps after a shared tail", () => {
    const steps = [s("d", route("a", "b", "end")), s("a", { next: "j" }), s("b", { next: "end" }), s("j"), s("k")];
    expect(stepPathCaptions(steps)).toEqual([null, "on path · bug", "on path · spec · ends the run", "on path · bug", "on path · bug · ends the run"]);
    const shared = [s("d", route("a", "b", "end")), s("a", { next: "j" }), s("b"), s("j"), s("k")];
    expect(stepPathCaptions(shared)).toEqual([null, "on path · bug", "on path · spec", "paths rejoin here", null]);
  });

  it("keeps a path labeled otherwise apart from the fallback, and treats goto end as the sentinel", () => {
    const steps = [s("d", { route: { paths: [{ when: "otherwise", goto: "a" }, { when: "b", goto: "end" }], otherwise: "o" } }), s("a", { next: "j" }), s("o"), s("j")];
    expect(stepPathCaptions(steps)[3]).toBe("paths rejoin here · ends the run");
    const endId = [s("d", route("end", "b", "b")), s("b", { next: "end" }), s("end")];
    expect(stepPathCaptions(endId)[2]).toBeNull();
    expect(stepEdgeWarnings(endId)).toEqual([null, null, null]);
  });

  it("is all null without a route", () => {
    expect(stepPathCaptions([s("a"), s("b", { next: "end" })])).toEqual([null, null]);
  });
});

describe("stepFlow", () => {
  const edges = (steps: RoutineStep[]) => stepFlow(steps).edges;
  const flagged = (steps: RoutineStep[]) => stepFlow(steps).nodes.map((n) => n.flagged);

  it("a linear sprout falls through and ends after the last step", () => {
    expect(edges([s("a"), s("b")])).toEqual([
      { from: 0, to: 1, kind: "flow" },
      { from: 1, to: "end", kind: "flow" },
    ]);
  });

  it("follows a next skip and next: end", () => {
    expect(edges([s("a", { next: "c" }), s("b", { next: "end" }), s("c")])).toEqual([
      { from: 0, to: 2, kind: "next" },
      { from: 1, to: "end", kind: "next" },
      { from: 2, to: "end", kind: "flow" },
    ]);
  });

  it("draws a gate's pass, forward fail, loop (with its round cap), and stop", () => {
    expect(edges([s("a", { gate: { onFail: { goto: "c" } } }), s("b"), s("c")]).slice(0, 2)).toEqual([
      { from: 0, to: 1, kind: "pass" },
      { from: 0, to: 2, kind: "fail" },
    ]);
    expect(edges([s("a"), s("b", { gate: { onFail: { goto: "a", maxRounds: 4 } } })]).slice(1)).toEqual([
      { from: 1, to: "end", kind: "pass" },
      { from: 1, to: 0, kind: "loop", maxRounds: 4 },
    ]);
    expect(edges([s("a"), s("b", { gate: { onFail: { goto: "a" } } })])[2]).toEqual({ from: 1, to: 0, kind: "loop", maxRounds: 3 });
    expect(edges([s("a", { gate: { onFail: "stop" } })])).toEqual([
      { from: 0, to: "end", kind: "pass" },
      { from: 0, to: "stop", kind: "fail" },
    ]);
  });

  it("a three-way route with a rejoin; unset otherwise stops", () => {
    expect(edges(triage())).toEqual([
      { from: 0, to: 1, kind: "path", label: "bug" },
      { from: 0, to: 2, kind: "path", label: "spec" },
      { from: 0, to: 3, kind: "path", label: "reply" },
      { from: 0, to: "stop", kind: "otherwise" },
      { from: 1, to: 4, kind: "next" },
      { from: 2, to: 4, kind: "next" },
      { from: 3, to: 4, kind: "flow" },
      { from: 4, to: "end", kind: "flow" },
    ]);
  });

  it("route paths that end: goto end, a tail next: end, and running off the last step", () => {
    const steps = [s("r", route("end", "b", "c", "c")), s("b", { next: "end" }), s("c")];
    expect(edges(steps)).toEqual([
      { from: 0, to: "end", kind: "path", label: "bug" },
      { from: 0, to: 1, kind: "path", label: "spec" },
      { from: 0, to: 2, kind: "path", label: "reply" },
      { from: 0, to: 2, kind: "otherwise" },
      { from: 1, to: "end", kind: "next" },
      { from: 2, to: "end", kind: "flow" },
    ]);
  });

  it("keeps a path labelled otherwise apart from the fallback", () => {
    const steps = [s("r", { route: { paths: [{ when: "otherwise", goto: "b" }, { when: "x", goto: "end" }], otherwise: "end" } }), s("b")];
    expect(edges(steps).filter((e) => e.from === 0)).toEqual([
      { from: 0, to: 1, kind: "path", label: "otherwise" },
      { from: 0, to: "end", kind: "path", label: "x" },
      { from: 0, to: "end", kind: "otherwise" },
    ]);
  });

  it("omits a broken edge mid-edit and flags its step, without throwing", () => {
    const half = [s("a", { next: "" }), s("b", { gate: { onFail: { goto: "" } } }), s("c", { route: { paths: [{ when: "x", goto: "" }, { when: "y", goto: "end" }] } })];
    expect(flagged(half)).toEqual([true, true, true]);
    expect(edges(half)).toEqual([{ from: 1, to: 2, kind: "pass" }]);
    expect(flagged(half)).toEqual(stepEdgeProblems(half).map((p) => p !== null));
    // A backward next and a duplicate id don't throw either.
    expect(() => stepFlow([s("a"), s("a", { next: "a" })])).not.toThrow();
    expect(edges([s("a"), s("a", { next: "a" })])).toEqual([{ from: 0, to: 1, kind: "flow" }]);
  });

  it("draws id-less legacy steps and never assigns ids", () => {
    const legacy = [{ kind: "chat", instruction: "x" }, { kind: "command", command: "true" }] as RoutineStep[];
    const flow = stepFlow(legacy);
    expect(flow.nodes.map((n) => [n.key, n.id, n.kind])).toEqual([["0:", undefined, "chat"], ["1:", undefined, "command"]]);
    expect(flow.edges).toEqual([{ from: 0, to: 1, kind: "flow" }, { from: 1, to: "end", kind: "flow" }]);
    expect(legacy.every((st) => st.id === undefined)).toBe(true);
  });
});
