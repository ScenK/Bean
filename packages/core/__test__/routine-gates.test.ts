// packages/core/__test__/routine-gates.test.ts
import { describe, expect, it } from "vitest";
import { runRoutine, type DelegateStepRequest, type RoutineRunnerDeps, type StepInfo } from "../src/routine-runner.js";
import { describeRoutineError, usesGates, type Routine, type RoutineStep } from "../src/routine-store.js";
import { gateVerdict, routeLabel } from "../src/step-attempts.js";
import { stepEdgeProblems } from "../src/routine-graph.js";
import type { StepAttempt, TodoItem, TodoStatus } from "../src/index.js";

/** A claim() fake: hands out a copy of `items` front to back. */
const claimFrom = (items: TodoItem[]) => { const q = [...items]; return async () => q.shift(); };

const routine = (steps: RoutineStep[], over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {}, ...over });

/** Each delegate call answers from `script[step id]` in order (last answer repeats). */
function fakeDelegate(script: Record<string, string[]>) {
  const calls: DelegateStepRequest[] = [];
  const ids: string[] = [];
  const delegate: RoutineRunnerDeps["delegate"] = async (req) => {
    calls.push(req);
    const id = /^\[(\w[\w-]*)\]/.exec(req.instruction)?.[1] ?? "?";
    ids.push(id);
    const answers = script[id] ?? ["done"];
    const out = answers.length > 1 ? answers.shift()! : answers[0]!;
    return { output: out, cli: "claude", sessionId: `sess-${id}-${ids.filter((x) => x === id).length}` };
  };
  return { delegate, calls, ids };
}

const step = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep =>
  ({ kind: "delegate", id, skill: "s", instruction: `[${id}] do ${id}`, ...extra }) as RoutineStep;

const deps = (delegate: RoutineRunnerDeps["delegate"], over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps => ({
  chat: async () => ({ content: "digest", toolCalls: [] }), model: "gpt-test", delegate, tools: [],
  findSkill: () => undefined, now: () => new Date("2026-10-13T06:00:00Z"), ...over,
});

const PASS = "looks good\nVERDICT: PASS";
const FAIL = "missing tests\nVERDICT: FAIL";

describe("gateVerdict", () => {
  it("PASS only on an exact last line; CRLF and trailing blanks tolerated", () => {
    expect(gateVerdict("ok\r\nVERDICT: PASS\r\n\r\n")).toBe("PASS");
    expect(gateVerdict("VERDICT: FAIL")).toBe("FAIL");
    expect(gateVerdict("no verdict here")).toBe("FAIL");
    expect(gateVerdict("")).toBe("FAIL");
    expect(gateVerdict("VERDICT: PASS\nbut then more text")).toBe("FAIL");
    expect(gateVerdict('the doc says "VERDICT: PASS" is the format\nVERDICT: maybe')).toBe("FAIL");
    expect(gateVerdict("VERDICT: pass")).toBe("FAIL");
  });
});

describe("gate validation", () => {
  const err = (steps: unknown[]): string | null =>
    describeRoutineError({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {} });
  const s = (id: string, extra: object = {}) => ({ kind: "chat", id, instruction: "x", ...extra });

  it("accepts stop, a forward branch, a bounded loop, and next: end", () => {
    expect(err([s("a", { gate: { onFail: "stop" } }), s("b", { gate: { onFail: { goto: "a", maxRounds: 5 } }, next: "end" }), s("c")])).toBeNull();
    expect(err([s("a", { gate: { onFail: { goto: "c" } } }), s("b", { next: "end" }), s("c")])).toBeNull();
  });

  it("rejects unknown targets, backward/self next, self-goto, bad maxRounds, and malformed gates", () => {
    expect(err([s("a", { gate: { onFail: { goto: "zz" } } })])).toMatch(/step 1: gate goto step "zz" doesn't exist/);
    expect(err([s("a"), s("b", { next: "a" })])).toMatch(/step 2: next must point to a later step/);
    expect(err([s("a", { next: "a" })])).toMatch(/step 1: next must point to a later step/);
    expect(err([s("a", { next: "nope" })])).toMatch(/next step "nope" doesn't exist/);
    expect(err([s("a", { gate: { onFail: { goto: "a" } } })])).toMatch(/can't goto its own step/);
    expect(err([s("a"), s("b", { gate: { onFail: { goto: "a", maxRounds: 6 } } })])).toMatch(/maxRounds must be a whole number from 1 to 5/);
    expect(err([s("a"), s("b", { gate: { onFail: { goto: "a", maxRounds: 0 } } })])).toMatch(/maxRounds/);
    expect(err([s("a", { gate: { onFail: { goto: "b", maxRounds: 2 } } }), s("b")])).toMatch(/maxRounds only applies to a loop/);
    expect(err([s("a", { gate: { onFail: "retry" } })])).toMatch(/gate.onFail must be/);
    expect(err([s("a", { gate: {} })])).toMatch(/gate.onFail must be/);
  });
});

describe("gated runs", () => {
  it("maxParallel: a gated sprout runs one claimed todo per call — its own scratch dir, loop and status, no claiming", async () => {
    const statuses: [string, TodoStatus][] = [];
    const f = fakeDelegate({ review: [FAIL, PASS] });
    const one = { id: "t9", routine: "r", text: "only me", status: "running", createdAt: "x" } as TodoItem;
    const res = await runRoutine(routine(loop(3), { todoDriven: true, maxParallel: 3 }), deps(f.delegate, {
      todos: { claim: async () => { throw new Error("must not claim"); }, setStatus: async (id, s) => { statuses.push([id, s]); } },
    }), one);
    expect(f.ids).toEqual(["impl", "review", "impl", "review", "pr"]);
    expect(f.calls.every((c) => c.todoId === "t9" && c.instruction.includes("only me"))).toBe(true);
    expect(statuses).toEqual([["t9", "done"]]);
    expect(res.record.status).toBe("ok");
  });

  it('onFail "stop" ends the run needs-attention; later steps never run', async () => {
    const f = fakeDelegate({ lint: [FAIL] });
    const res = await runRoutine(routine([step("lint", { gate: { onFail: "stop" } }), step("impl")]), deps(f.delegate));
    expect(f.ids).toEqual(["lint"]);
    expect(res.record.status).toBe("needs-attention");
    expect(res.digest).toMatch(/^Needs attention: stopped at lint — missing tests/);
  });

  it("appends the verdict contract to gated steps only", async () => {
    const f = fakeDelegate({ lint: [PASS] });
    await runRoutine(routine([step("lint", { gate: { onFail: "stop" } }), step("impl")]), deps(f.delegate));
    expect(f.calls[0]!.instruction).toMatch(/exactly `VERDICT: PASS`.*`VERDICT: FAIL`/s);
    expect(f.calls[1]!.instruction).not.toMatch(/VERDICT/);
  });

  it("a forward goto skips intermediate steps, and next: end keeps branch-only tails off the happy path", async () => {
    const steps = [
      step("lint", { gate: { onFail: { goto: "clarify" } } }), step("impl"), step("pr", { next: "end" }), step("clarify"),
    ];
    const fail = fakeDelegate({ lint: [FAIL] });
    const failed = await runRoutine(routine(steps), deps(fail.delegate));
    expect(fail.ids).toEqual(["lint", "clarify"]);
    // The last gate decision was FAIL → needs attention even though the branch ran fine.
    expect(failed.record.status).toBe("needs-attention");
    expect(fail.calls[1]!.instruction).toMatch(/The check at step "lint" failed[\s\S]*<<<\nmissing tests\nVERDICT: FAIL\n>>>/);

    const pass = fakeDelegate({ lint: [PASS] });
    const passed = await runRoutine(routine(steps), deps(pass.delegate));
    expect(pass.ids).toEqual(["lint", "impl", "pr"]);
    expect(passed.record.status).toBe("ok");
  });

  const loop = (maxRounds?: number): RoutineStep[] => [
    step("impl"),
    step("review", { gate: { onFail: { goto: "impl", ...(maxRounds ? { maxRounds } : {}) } } }),
    step("pr"),
  ];

  it("backward loop: PASS first time runs straight through", async () => {
    const f = fakeDelegate({ review: [PASS] });
    const res = await runRoutine(routine(loop()), deps(f.delegate));
    expect(f.ids).toEqual(["impl", "review", "pr"]);
    expect(res.record.status).toBe("ok");
  });

  it("backward loop: FAIL then PASS ends ok, resuming the target's own session with only the newest FAIL", async () => {
    const f = fakeDelegate({ review: ["first review\nVERDICT: FAIL", "second review\nVERDICT: FAIL", PASS] });
    const seen: StepInfo[] = [];
    const attempts: StepAttempt[] = [];
    const res = await runRoutine(routine(loop()), deps(f.delegate, {
      onStep: (i) => seen.push(i), recordAttempt: (a) => attempts.push(a),
    }));
    expect(f.ids).toEqual(["impl", "review", "impl", "review", "impl", "review", "pr"]);
    expect(res.record.status).toBe("ok");
    expect(f.calls[0]!.resume).toBeUndefined();
    expect(f.calls[2]!.resume).toEqual({ cli: "claude", sessionId: "sess-impl-1" });
    expect(f.calls[4]!.resume).toEqual({ cli: "claude", sessionId: "sess-impl-2" });
    // Third impl gets the second review only — never the first.
    expect(f.calls[4]!.instruction).toMatch(/second review/);
    expect(f.calls[4]!.instruction).not.toMatch(/first review/);
    // Prior block keeps the latest attempt per step: the stale review never replays.
    expect(f.calls[4]!.priorOutputs).toMatch(/second review/);
    expect(f.calls[4]!.priorOutputs).not.toMatch(/first review/);
    expect(seen.map((s) => `${s.id}#${s.round}`)).toEqual(["impl#1", "review#1", "impl#2", "review#2", "impl#3", "review#3", "pr#1"]);
    expect(attempts.filter((a) => a.stepId === "review").map((a) => [a.round, a.verdict])).toEqual([[1, "FAIL"], [2, "FAIL"], [3, "PASS"]]);
    expect(res.record.steps.filter((s) => s.id === "review").map((s) => s.round)).toEqual([1, 2, 3]);
  });

  it("backward loop: FAIL every round ends needs-attention after maxRounds executions of the gate", async () => {
    const f = fakeDelegate({ review: [FAIL] });
    const res = await runRoutine(routine(loop(2)), deps(f.delegate));
    expect(f.ids).toEqual(["impl", "review", "impl", "review"]);
    expect(res.record.status).toBe("needs-attention");
    expect(res.digest).toMatch(/stopped at review — missing tests \(still failing after 2 rounds\)/);

    const dflt = fakeDelegate({ review: [FAIL] });
    await runRoutine(routine(loop()), deps(dflt.delegate));
    expect(dflt.ids.filter((x) => x === "review")).toHaveLength(3);
  });

  it("a missing verdict, PASS mid-output, or a quoted VERDICT: PASS all count as FAIL", async () => {
    for (const out of ["all good", "VERDICT: PASS\nmore notes", 'reply with "VERDICT: PASS" when done\n']) {
      const f = fakeDelegate({ lint: [out] });
      const res = await runRoutine(routine([step("lint", { gate: { onFail: "stop" } }), step("impl")]), deps(f.delegate));
      expect(res.record.status).toBe("needs-attention");
      expect(f.ids).toEqual(["lint"]);
    }
  });

  it("a hard step error stops a gated run failed", async () => {
    const delegate: RoutineRunnerDeps["delegate"] = async (req) => {
      if (req.instruction.startsWith("[impl]")) throw new Error("spawn failed");
      return PASS;
    };
    const seen: string[] = [];
    const res = await runRoutine(routine([step("impl"), step("review", { gate: { onFail: "stop" } })]), deps(delegate, {
      onStep: (i) => seen.push(i.id ?? ""),
    }));
    expect(seen).toEqual(["impl"]);
    expect(res.record.status).toBe("failed");
  });

  it("todo isolation: rounds never leak across todos, and a needs-attention todo fails with a lead summary", async () => {
    const pending: TodoItem[] = [
      { id: "t1", routine: "r", text: "one", status: "pending", createdAt: "x" },
      { id: "t2", routine: "r", text: "two", status: "pending", createdAt: "x" },
    ] as TodoItem[];
    const statuses: [string, TodoStatus, string | undefined][] = [];
    const f = fakeDelegate({ review: [FAIL, FAIL, FAIL, PASS] });
    const res = await runRoutine(routine(loop(3), { todoDriven: true }), deps(f.delegate, {
      todos: {
        claim: claimFrom(pending),
        setStatus: async (id, s, sum) => { statuses.push([id, s, sum]); },
      },
    }));
    // t1 exhausts 3 rounds; t2 starts fresh at round 1 with no resume from t1's sessions.
    expect(f.ids).toEqual(["impl", "review", "impl", "review", "impl", "review", "impl", "review", "pr"]);
    expect(f.calls[6]!.resume).toBeUndefined();
    expect(statuses.filter(([, s]) => s !== "running")).toEqual([
      ["t1", "failed", "needs attention: stopped at review — missing tests (still failing after 3 rounds)"],
      ["t2", "done", expect.any(String)],
    ]);
    expect(res.record.status).toBe("needs-attention");
  });
});

describe("legacy routines (no gate/next)", () => {
  it("have no execution limit", async () => {
    const steps = Array.from({ length: 51 }, (_, i): RoutineStep => ({ kind: "delegate", skill: "s", instruction: `s${i}` }));
    const res = await runRoutine(routine(steps), deps(async () => "ok"));
    expect(res.record.steps).toHaveLength(51);
    expect(res.record.status).toBe("ok");
  });

  it("still continue past a failed step and ignore VERDICT lines", async () => {
    const seen: StepInfo[] = [];
    const delegate: RoutineRunnerDeps["delegate"] = async (req) => {
      if (req.instruction === "b") throw new Error("boom");
      return "report\nVERDICT: FAIL";
    };
    const res = await runRoutine(routine([
      { kind: "delegate", skill: "s", instruction: "a" },
      { kind: "delegate", skill: "s", instruction: "b" },
      { kind: "delegate", skill: "s", instruction: "c" },
    ]), deps(delegate, { onStep: (i) => seen.push(i) }));
    expect(seen).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(res.record.status).toBe("failed");
    expect(res.record.steps.map((s) => s.ok)).toEqual([true, false, true]);
    expect(res.record.steps.every((s) => s.round === undefined)).toBe(true);
    expect(res.digest).not.toMatch(/Needs attention/);
  });
});

describe("stepEdgeProblems (the editor's inline check)", () => {
  it("flags edges a reorder broke, per step, with the save-time wording", () => {
    const steps: RoutineStep[] = [
      { kind: "command", id: "test", command: "pnpm test", gate: { onFail: { goto: "implement", maxRounds: 3 } } },
      { kind: "chat", id: "implement", instruction: "fix", next: "test" },
      { kind: "chat", id: "pr", instruction: "open a pr", gate: { onFail: { goto: "gone" } } },
    ];
    expect(stepEdgeProblems(steps)).toEqual([
      'step 1: maxRounds only applies to a loop (a goto to an earlier step)',
      'step 2: next must point to a later step (or "end") — loop back with a gate instead',
      'step 3: gate goto step "gone" doesn\'t exist',
    ]);
  });
});

describe("routeLabel", () => {
  it("takes a declared label only from an exact last line", () => {
    const labels = ["bug", "feature"];
    expect(routeLabel("triaged\r\nROUTE: bug\r\n\r\n", labels)).toBe("bug");
    expect(routeLabel("ROUTE:feature", labels)).toBe("feature");
    expect(routeLabel("no route", labels)).toBeUndefined();
    expect(routeLabel('ROUTE: "bug"', labels)).toBeUndefined();
    expect(routeLabel("ROUTE: bug\nmore text", labels)).toBeUndefined();
    expect(routeLabel("ROUTE: question", labels)).toBeUndefined();
    expect(routeLabel("ROUTE: Bug", labels)).toBeUndefined();
  });
});

describe("route validation", () => {
  const err = (steps: unknown[]): string | null =>
    describeRoutineError({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {} });
  const s = (id: string, extra: object = {}) => ({ kind: "chat", id, instruction: "x", ...extra });
  const two = (over: object = {}) => ({ paths: [{ when: "a", goto: "x" }, { when: "b", goto: "end" }], ...over });

  it("accepts a route to later steps / end, with an optional otherwise", () => {
    expect(err([s("d", { route: two({ otherwise: "y" }) }), s("x"), s("y")])).toBeNull();
    expect(err([s("d", { route: two() }), s("x")])).toBeNull();
  });

  it("rejects each invalid shape", () => {
    expect(err([s("d", { route: { paths: [{ when: "a", goto: "x" }] } }), s("x")])).toMatch(/step 1: a route needs at least 2 paths/);
    expect(err([s("d", { route: "x" }), s("x")])).toMatch(/at least 2 paths/);
    expect(err([s("d", { route: { paths: [{ when: "A b", goto: "x" }, { when: "b", goto: "x" }] } }), s("x")])).toMatch(/route label must use a-z/);
    expect(err([s("d", { route: { paths: [{ when: "PASS", goto: "x" }, { when: "b", goto: "x" }] } }), s("x")])).toMatch(/route label must use a-z/);
    expect(err([s("d", { route: { paths: [{ when: "fail", goto: "x" }, { when: "b", goto: "x" }] } }), s("x")])).toMatch(/"fail" can't be a route label/);
    expect(err([s("d", { route: { paths: [{ when: "a", goto: "x" }, { when: "a", goto: "end" }] } }), s("x")])).toMatch(/route label "a" is used twice/);
    expect(err([s("d", { route: two() }), s("y")])).toMatch(/route "a" step "x" doesn't exist/);
    expect(err([s("x"), s("d", { route: two() })])).toMatch(/step 2: route "a" must point to a later step/);
    expect(err([s("d", { route: { paths: [{ when: "a", goto: "d" }, { when: "b", goto: "end" }] } })])).toMatch(/must point to a later step/);
    expect(err([s("d", { route: { paths: [{ when: "a" }, { when: "b", goto: "end" }] } })])).toMatch(/route "a" needs a step id or "end"/);
    expect(err([s("x"), s("d", { route: { paths: [{ when: "a", goto: "end" }, { when: "b", goto: "end" }], otherwise: "x" } })])).toMatch(/route otherwise must point to a later step/);
    expect(err([s("d", { route: two(), gate: { onFail: "stop" } }), s("x")])).toMatch(/can't be combined with a gate or next/);
    expect(err([s("d", { route: two(), next: "end" }), s("x")])).toMatch(/can't be combined with a gate or next/);
  });
});

describe("routed runs", () => {
  const triage = (over: object = {}): RoutineStep => step("triage", {
    route: { paths: [{ when: "bug", goto: "fix" }, { when: "feature", goto: "build" }, { when: "question", goto: "answer" }], ...over },
  });
  const threeWay = (over: object = {}): RoutineStep[] => [
    triage(over), step("fix", { next: "ship" }), step("build", { next: "ship" }), step("answer", { next: "ship" }), step("ship"),
  ];

  it("a three-way route with a rejoin runs only the chosen path and the shared step", async () => {
    expect(describeRoutineError(routine(threeWay()))).toBeNull();
    const attempts: StepAttempt[] = [];
    const f = fakeDelegate({ triage: ["it crashes\nROUTE: feature"] });
    const res = await runRoutine(routine(threeWay()), deps(f.delegate, { recordAttempt: (a) => attempts.push(a) }));
    expect(f.ids).toEqual(["triage", "build", "ship"]);
    expect(res.record.status).toBe("ok");
    expect(f.calls[0]!.instruction).toMatch(/exactly `ROUTE: <label>`, where <label> is one of: bug, feature, question/);
    expect(f.calls[1]!.instruction).not.toMatch(/ROUTE/);
    // The prior block names the choice and drops the ROUTE line; history keeps it raw.
    expect(f.calls[1]!.priorOutputs).toBe('--- step 1 (delegate, ok, chose "feature") ---\nit crashes');
    expect(res.record.steps[0]).toMatchObject({ id: "triage", verdict: "feature", chose: "feature", summary: "it crashes", round: 1 });
    expect(res.record.steps[1]).not.toHaveProperty("chose");
    expect(attempts[0]).toMatchObject({ verdict: "feature", output: "it crashes\nROUTE: feature" });
  });

  it('goto "end", a tail next: "end", and running off the last step all end ok; a todo ends done', async () => {
    const steps = (endAt: object): RoutineStep[] => [
      step("d", { route: { paths: [{ when: "stop", goto: "end" }, { when: "go", goto: "tail" }] } }),
      step("skipped"), step("tail", endAt), step("after"),
    ];
    const toEnd = fakeDelegate({ d: ["ROUTE: stop"] });
    expect((await runRoutine(routine(steps({})), deps(toEnd.delegate))).record.status).toBe("ok");
    expect(toEnd.ids).toEqual(["d"]);

    const tailEnd = fakeDelegate({ d: ["ROUTE: go"] });
    expect((await runRoutine(routine(steps({ next: "end" })), deps(tailEnd.delegate))).record.status).toBe("ok");
    expect(tailEnd.ids).toEqual(["d", "tail"]);

    const offEnd = fakeDelegate({ d: ["ROUTE: go"] });
    expect((await runRoutine(routine(steps({})), deps(offEnd.delegate))).record.status).toBe("ok");
    expect(offEnd.ids).toEqual(["d", "tail", "after"]);

    const statuses: [string, TodoStatus][] = [];
    const todo = fakeDelegate({ d: ["ROUTE: stop"] });
    const one = { id: "t1", routine: "r", text: "go", status: "running", createdAt: "x" } as TodoItem;
    await runRoutine(routine(steps({}), { todoDriven: true }), deps(todo.delegate, {
      todos: { claim: async () => undefined, setStatus: async (id, s) => { statuses.push([id, s]); } },
    }), one);
    expect(statuses).toEqual([["t1", "done"]]);
  });

  it("a missing, malformed, quoted, mid-output or undeclared label takes otherwise, else needs attention", async () => {
    for (const said of ["no route here", "ROUTE bug", 'ROUTE: "bug"', "ROUTE: bug\nthen more", "ROUTE: chore"]) {
      const withDefault = fakeDelegate({ triage: [said] });
      const res = await runRoutine(routine(threeWay({ otherwise: "answer" })), deps(withDefault.delegate));
      expect(withDefault.ids).toEqual(["triage", "answer", "ship"]);
      expect(res.record.status).toBe("ok");
      expect(res.record.steps[0]!.verdict).toBeUndefined();

      const without = fakeDelegate({ triage: [said] });
      const stuck = await runRoutine(routine(threeWay()), deps(without.delegate));
      expect(without.ids).toEqual(["triage"]);
      expect(stuck.record.status).toBe("needs-attention");
      expect(stuck.digest).toContain(`Needs attention: no path matched at triage (said: '${said.split("\n").at(-1)}')`);
    }
  });

  it("a command step routes on its stdout ROUTE line; a non-zero exit fails the step", async () => {
    const steps: RoutineStep[] = [
      { kind: "command", id: "probe", command: "./probe", route: { paths: [{ when: "dirty", goto: "clean" }, { when: "tidy", goto: "end" }] } },
      step("clean"),
    ];
    const f = fakeDelegate({});
    const res = await runRoutine(routine(steps), deps(f.delegate, { command: async () => ({ exitCode: 0, output: "3 files\nROUTE: dirty\n" }) }));
    expect(f.ids).toEqual(["clean"]);
    expect(res.record.steps[0]).toMatchObject({ verdict: "dirty", summary: "3 files\n(exit 0)" });
    expect(res.record.status).toBe("ok");

    const bad = fakeDelegate({});
    const failed = await runRoutine(routine(steps), deps(bad.delegate, { command: async () => ({ exitCode: 2, output: "ROUTE: dirty" }) }));
    expect(bad.ids).toEqual([]);
    expect(failed.record.status).toBe("failed");
    expect(failed.record.steps[0]).toMatchObject({ ok: false, summary: "ROUTE: dirty\n(exit 2)" });
  });

  it("a sprout whose only edges are routes still runs as a graph", async () => {
    const steps = threeWay().map((s) => ({ ...s, next: undefined }));
    expect(usesGates(steps)).toBe(true);
    const f = fakeDelegate({ triage: ["ROUTE: answer-me"] });
    const res = await runRoutine(routine([
      step("triage", { route: { paths: [{ when: "answer-me", goto: "answer" }, { when: "other", goto: "end" }] } }),
      step("fix"), step("answer"),
    ]), deps(f.delegate));
    expect(f.ids).toEqual(["triage", "answer"]);
    expect(res.record.steps.map((s) => s.round)).toEqual([1, 1]);
  });

  it('a lone decider routed to "end" delivers its report without the ROUTE line; the attempt keeps it', async () => {
    const attempts: StepAttempt[] = [];
    const f = fakeDelegate({ d: ["All quiet today.\nROUTE: done"] });
    const res = await runRoutine(routine([
      step("d", { route: { paths: [{ when: "done", goto: "end" }, { when: "more", goto: "x" }] } }), step("x"),
    ]), deps(f.delegate, { recordAttempt: (a) => attempts.push(a) }));
    expect(res.digest).toBe("All quiet today.");
    expect(attempts[0]!.output).toBe("All quiet today.\nROUTE: done");
  });

  it("a member todo is refused when a delegate step sits only on an untaken path", async () => {
    const statuses: [string, TodoStatus][] = [];
    const f = fakeDelegate({});
    const chat: RoutineRunnerDeps["chat"] = async () => ({ content: "ROUTE: easy", toolCalls: [] });
    const r = routine([
      { kind: "chat", id: "d", instruction: "decide", route: { paths: [{ when: "easy", goto: "end" }, { when: "hard", goto: "code" }] } },
      step("code"),
    ], { todoDriven: true });
    const one = { id: "t1", routine: "r", text: "hi", status: "running", createdAt: "x", createdBy: "member-1" } as TodoItem;
    await runRoutine(r, deps(f.delegate, {
      chat, todos: { claim: async () => undefined, setStatus: async (id, s) => { statuses.push([id, s]); } },
    }), one);
    expect(f.ids).toEqual([]);
    expect(statuses).toEqual([["t1", "failed"]]);
  });
});
