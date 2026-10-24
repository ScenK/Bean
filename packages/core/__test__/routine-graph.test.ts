import { describe, expect, it } from "vitest";
import type { RoutineStep } from "../src/routine-store.js";
import { stepEdgeProblems, stepEdgeWarnings, stepPathCaptions } from "../src/routine-graph.js";

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

  it("is all null without a route", () => {
    expect(stepPathCaptions([s("a"), s("b", { next: "end" })])).toEqual([null, null]);
  });
});
