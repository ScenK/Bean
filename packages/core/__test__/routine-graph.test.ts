import { describe, expect, it } from "vitest";
import { describeRoutineError, usesGates, type RoutineStep } from "../src/routine-store.js";
import { stepEdgeProblems, stepEdgeWarnings, stepFlow, stepGroupCaptions, stepGroups, stepPathCaptions } from "../src/routine-graph.js";

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

describe("stepGroupCaptions", () => {
  it("captions the first member, the other members and the join", () => {
    const steps = [s("a"), s("b"), s("c", { alongside: true }), s("d", { alongside: true }), s("e")];
    expect(stepGroupCaptions(steps)).toEqual([
      null, "starts a group of 3 · joins at 5", "runs alongside 2", "runs alongside 2", "waits for steps 2–4",
    ]);
  });

  it("says joins at end for a closing group, and stacks both captions between back-to-back groups", () => {
    expect(stepGroupCaptions([s("a"), s("b", { alongside: true })])).toEqual(["starts a group of 2 · joins at end", "runs alongside 1"]);
    const steps = [s("a"), s("b", { alongside: true }), s("c"), s("d", { alongside: true })];
    expect(stepGroupCaptions(steps)[2]).toBe("waits for steps 1–2 · starts a group of 2 · joins at end");
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

describe("parallel groups", () => {
  const al = { alongside: true } as const;
  const save = (steps: RoutineStep[]) => describeRoutineError({ name: "x", enabled: true, cron: "0 6 * * *", steps, sinks: {} });
  // Each rule shows the same text in the editor and blocks the save.
  const rejects = (steps: RoutineStep[], i: number, text: string) => {
    const problems = stepEdgeProblems(steps);
    expect(problems[i]).toBe(text);
    expect(problems.filter((p) => p !== null)).toHaveLength(1);
    expect(save(steps)).toBe(text);
  };
  const ok = (steps: RoutineStep[]) => {
    expect(stepEdgeProblems(steps).every((p) => p === null)).toBe(true);
    expect(save(steps)).toBeNull();
  };

  it("groups a step with the run of alongside steps below it: step-1 groups, back-to-back groups, end-of-run joins", () => {
    expect(stepGroups([s("a"), s("b", al), s("c", al), s("d")])).toEqual([{ first: 0, last: 2 }]);
    expect(stepGroups([s("a"), s("b", al), s("c"), s("d", al)])).toEqual([{ first: 0, last: 1 }, { first: 2, last: 3 }]);
    expect(stepGroups([s("a"), s("b")])).toEqual([]);
    ok([s("a"), s("b", al), s("c", al), s("d")]);
    ok([s("a"), s("b", al), s("c"), s("d", al)]);
    ok([s("a"), s("b"), s("c", al)]);
  });

  it("turns on graph mode only with alongside (or another edge)", () => {
    expect(usesGates([s("a"), s("b", al)])).toBe(true);
    expect(usesGates([s("a"), s("b")])).toBe(false);
  });

  it("alongside must be true; step 1 can't be alongside", () => {
    rejects([s("a"), s("b", { alongside: false } as unknown as Partial<RoutineStep>)], 1, "step 2: alongside must be true when present");
    rejects([s("a", al), s("b")], 0, "step 1 can't run alongside — there's no step above it");
  });

  it("caps a group at 4 steps", () => {
    ok([s("a"), s("b", al), s("c", al), s("d", al)]);
    rejects([s("z"), s("a"), s("b", al), s("c", al), s("d", al), s("e", al)], 5,
      "step 6: a group runs at most 4 steps — steps 2–5 already run together");
  });

  it("rejects a gate, next or route on any member, naming the step whose toggle made it one", () => {
    rejects([s("a", { gate: { onFail: "stop" } }), s("b", al)], 0, "step 1: step 2 runs alongside it, so it can't have a gate, next or route");
    rejects([s("a"), s("b", { ...al, next: "end" })], 1, "step 2 runs alongside step 1, so it can't have a gate, next or route");
    rejects([s("a"), s("b", al), s("c", { ...al, ...route("end", "end", "end") })], 2, "step 3 runs alongside step 1, so it can't have a gate, next or route");
  });

  it("edges may target only a group's first member", () => {
    rejects([s("a", { next: "c" }), s("b"), s("c", al)], 0, "step 1: next can't point into a group — point it at step 2, where the group starts");
    rejects([s("a"), s("b", al), s("c", { gate: { onFail: { goto: "b" } } })], 2, "step 3: gate goto can't point into a group — point it at step 1, where the group starts");
    rejects([s("r", route("b", "end", "end")), s("a"), s("b", al)], 0, 'step 1: route "bug" can\'t point into a group — point it at step 2, where the group starts');
    rejects([s("r", route("end", "end", "end", "b")), s("a"), s("b", al)], 0, "step 1: route otherwise can't point into a group — point it at step 2, where the group starts");
    ok([s("a", { next: "b" }), s("x"), s("b"), s("c", al), s("d", { gate: { onFail: { goto: "b" } } })]);
  });

  it("a group ending a route path needs a join step after it", () => {
    const into = [s("r", route("a", "b", "end")), s("a"), s("a2", al), s("b")];
    rejects(into, 2, "step 3: path 'bug' ends in a group that runs on into path 'spec' — add a step after the group with next: end");
    expect(stepEdgeWarnings(into)).toEqual([null, null, null, null]);
    ok([s("r", route("a", "b", "end")), s("a"), s("a2", al), s("j", { next: "end" }), s("b")]);
    // At the run's end the join is the end itself.
    ok([s("r", route("b", "a", "end")), s("b", { next: "end" }), s("a"), s("a2", al)]);
  });

  it("stepFlow forks into each member and joins each member to the next step, with no member-to-member edge", () => {
    const { edges } = stepFlow([s("a"), s("b"), s("c", al), s("d")]);
    expect(edges).toEqual([
      { from: 0, to: 1, kind: "fork", via: "flow" },
      { from: 0, to: 2, kind: "fork", via: "flow" },
      { from: 1, to: 3, kind: "join" },
      { from: 2, to: 3, kind: "join" },
      { from: 3, to: "end", kind: "flow" },
    ]);
  });

  it("stepFlow keeps an entry's kind and label, keeps a loop as one lane, and joins at end", () => {
    expect(stepFlow([s("r", route("a", "end", "end")), s("a"), s("a2", al)]).edges.filter((e) => e.from === 0).slice(0, 2)).toEqual([
      { from: 0, to: 1, kind: "fork", via: "path", label: "bug" },
      { from: 0, to: 2, kind: "fork", via: "path", label: "bug" },
    ]);
    expect(stepFlow([s("a"), s("b", al), s("c", { gate: { onFail: { goto: "a" } } })]).edges).toEqual([
      { from: 0, to: 2, kind: "join" },
      { from: 1, to: 2, kind: "join" },
      { from: 2, to: "end", kind: "pass" },
      { from: 2, to: 0, kind: "loop", maxRounds: 3 },
    ]);
    expect(stepFlow([s("a"), s("b", al)]).edges).toEqual([{ from: 0, to: "end", kind: "join" }, { from: 1, to: "end", kind: "join" }]);
  });

  it("stepFlow joins back-to-back groups member to member", () => {
    expect(stepFlow([s("a"), s("b", al), s("c"), s("d", al)]).edges).toEqual([
      { from: 0, to: 2, kind: "join" },
      { from: 0, to: 3, kind: "join" },
      { from: 1, to: 2, kind: "join" },
      { from: 1, to: 3, kind: "join" },
      { from: 2, to: "end", kind: "join" },
      { from: 3, to: "end", kind: "join" },
    ]);
  });

  it("stepFlow drops a rejected edge into a group and flags its step", () => {
    const steps = [s("a", { next: "c" }), s("b"), s("c", al), s("d", { gate: { onFail: { goto: "c" } } })];
    const flow = stepFlow(steps);
    expect(flow.nodes.map((n) => n.flagged)).toEqual(stepEdgeProblems(steps).map((p) => p !== null));
    expect(flow.nodes.map((n) => n.flagged)).toEqual([true, false, false, true]);
    expect(flow.edges.filter((e) => e.to === 2 && e.kind !== "fork")).toEqual([]);
  });
});
