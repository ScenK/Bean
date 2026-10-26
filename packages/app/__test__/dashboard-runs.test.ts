import { describe, expect, test } from "vitest";
import { attemptSessions, attentionOf, bucketKeyFor, executedPath, flattenRuns, groupRuns, observedLanes, reviewRuns, runFlowOverlay, sessionSummary, splitSteps, stepLabel, unreadRuns } from "../src/renderer/components/dashboard/runs.js";
import type { RoutineStep, RunRecord } from "@bean/core";
import { stepFlow } from "@bean/core/routine-graph";
import type { RoutineStateView } from "../src/ipc.js";

const record = (startedAt: string, finishedAt: string, ok: boolean[]) => ({
  startedAt,
  finishedAt,
  status: ok.every(Boolean) ? ("ok" as const) : ("failed" as const),
  digest: "digest",
  steps: ok.map((o, i) => ({ kind: "chat" as const, ok: o, summary: `step ${i + 1}` })),
});

const states: Record<string, RoutineStateView> = {
  nightly: {
    running: false,
    history: [record("2026-09-21T22:04:00Z", "2026-09-22T07:15:00Z", [true, false, true])],
  },
  weekly: {
    running: false,
    history: [
      record("2026-09-20T08:00:00Z", "2026-09-20T08:30:00Z", [true]),
      record("2026-09-13T08:00:00Z", "2026-09-13T08:30:00Z", [false]),
    ],
  },
};

describe("dashboard runs", () => {
  test("flattens every routine's history into one newest-first stream", () => {
    const runs = flattenRuns(states);
    expect(runs.map((r) => `${r.routine}@${r.startedAt}`)).toEqual([
      "nightly@2026-09-21T22:04:00Z",
      "weekly@2026-09-20T08:00:00Z",
      "weekly@2026-09-13T08:00:00Z",
    ]);
    expect(runs[0]!.id).toBe("nightly@2026-09-21T22:04:00Z");
  });

  test("only failed steps need you; passing steps collapse into resolved", () => {
    const { needs, resolved } = splitSteps(flattenRuns(states)[0]);
    expect(needs.map((s) => s.index)).toEqual([1]);
    expect(resolved.map((s) => s.index)).toEqual([0, 2]);
  });

  test("a step needs you only if its latest attempt failed in a run that isn't ok", () => {
    const run = (status: "ok" | "failed", steps: RunRecord["steps"]) =>
      ({ routine: "r", id: "r@x", startedAt: "x", finishedAt: "y", status, digest: "", steps });
    const retried: RunRecord["steps"] = [
      { kind: "chat", id: "lint", round: 1, ok: false, summary: "boom" },
      { kind: "chat", id: "check", round: 1, ok: true, verdict: "FAIL", summary: "" },
      { kind: "chat", id: "lint", round: 2, ok: true, summary: "fine" },
      { kind: "chat", id: "check", round: 2, ok: true, verdict: "PASS", summary: "" },
    ];
    expect(splitSteps(run("ok", retried)).needs).toEqual([]);
    expect(splitSteps(run("ok", retried)).resolved).toHaveLength(4);
    expect(splitSteps(run("failed", retried)).needs).toEqual([]);
    expect(splitSteps(run("failed", retried.slice(0, 2))).needs.map((s) => s.id)).toEqual(["lint"]);
    expect(groupRuns(flattenRuns({ r: { running: false, history: [run("ok", retried)] } }))[0]!.needs).toBe(0);
  });

  test("no selected run means nothing needs you", () => {
    expect(splitSteps(undefined)).toEqual({ needs: [], resolved: [] });
  });

  test("a todo-labelled step names its todo instead of claiming a step number", () => {
    // A todo-driven run records one pass of every step per todo, so array position is not the
    // routine's step number — the runner's `[todo: ...] ` prefix is what disambiguates.
    const { needs } = splitSteps({
      routine: "queue",
      id: "queue@x",
      startedAt: "x",
      finishedAt: "y",
      status: "failed",
      digest: "",
      steps: [
        { kind: "chat", ok: true, summary: "[todo: ship the docs] wrote the page" },
        { kind: "chat", ok: false, summary: "[todo: rotate the token] no write access" },
      ],
    });
    expect(needs[0]!.todo).toBe("rotate the token");
    expect(needs[0]!.summary).toBe("no write access");
    expect(stepLabel(needs[0]!)).toBe("todo");
  });

  test("a todo prefix truncated by the summary cap is still a todo, never a step number", () => {
    const long = `[todo: ${"x".repeat(400)}`.slice(0, 200); // no closing "]" survives the cap
    const { needs } = splitSteps({
      routine: "queue",
      id: "queue@x",
      startedAt: "x",
      finishedAt: "y",
      status: "failed",
      digest: "",
      steps: [{ kind: "chat", ok: false, summary: long }],
    });
    expect(needs[0]!.todo).toBe("");
    expect(stepLabel(needs[0]!)).toBe("todo");
  });

  test("an unlabelled step keeps its position-based step number", () => {
    expect(stepLabel(splitSteps(flattenRuns(states)[0]).needs[0]!)).toBe("step 2");
  });

  test("groups the rail by local day, then by routine, with each day's runs in one bucket", () => {
    // Two runs of the same routine on one local day must be ONE rail row whose runs the spine
    // reads in order — that is the whole point of the bucket.
    const twice: Record<string, RoutineStateView> = {
      nightly: {
        running: false,
        history: [
          record("2026-09-21T22:04:00", "2026-09-21T23:15:00", [true, false]),
          record("2026-09-21T06:00:00", "2026-09-21T06:30:00", [true]),
          record("2026-09-19T06:00:00", "2026-09-19T06:30:00", [true]),
        ],
      },
      weekly: { running: false, history: [record("2026-09-21T08:00:00", "2026-09-21T08:30:00", [false])] },
    };
    const days = groupRuns(flattenRuns(twice));
    expect(days.map((d) => [d.date, d.runCount, d.needs])).toEqual([
      ["2026-09-21", 3, 2],
      ["2026-09-19", 1, 0],
    ]);
    const [today] = days;
    expect(today!.buckets.map((b) => [b.routine, b.runs.length, b.needs])).toEqual([
      ["nightly", 2, 1],
      ["weekly", 1, 1],
    ]);
    // Newest-first at every level, buckets included — the spine reads the latest run at the top
    // and labels it with its chronological ordinal (RUN 2 above RUN 1).
    expect(today!.buckets[0]!.runs.map((r) => r.startedAt)).toEqual([
      "2026-09-21T22:04:00",
      "2026-09-21T06:00:00",
    ]);
    // Keys stay unique when two routines run on the same day.
    expect(today!.buckets.map((b) => b.key)).toEqual(["2026-09-21|nightly", "2026-09-21|weekly"]);
  });

  test("everything is unread until you review it, run by run", () => {
    const runs = flattenRuns(states);
    expect(unreadRuns(runs, new Set())).toHaveLength(3);
    const oneDay = runs.filter((r) => r.routine === "weekly").map((r) => r.id);
    const reviewed = new Set(reviewRuns(new Set(), oneDay, runs));
    // Reviewing one day leaves every other day unread — the whole point of scoping the button
    // to the panel instead of stamping a "seen up to here" time.
    expect(unreadRuns(runs, reviewed).map((r) => r.routine)).toEqual(["nightly"]);
  });

  test("reviewing drops ids for runs that have rolled out of the capped history", () => {
    const runs = flattenRuns(states);
    const stale = new Set(["nightly@1999-01-01T00:00:00Z"]);
    expect(reviewRuns(stale, [runs[0]!.id], runs)).toEqual([runs[0]!.id]);
  });

});

describe("gated runs", () => {
  const steps = [
    { kind: "command" as const, id: "test", round: 1, verdict: "FAIL", ok: true, summary: "1 failing" },
    { kind: "delegate" as const, id: "implement", round: 2, cli: "codex" as const, ok: true, summary: "fixed" },
    { kind: "command" as const, id: "test", round: 2, verdict: "FAIL", ok: true, summary: "still failing" },
  ];

  test("executedPath marks an ok-but-FAIL gate as ✗ and tags repeated rounds", () => {
    expect(executedPath({ steps })).toBe("test ✗ → implement r2 ✓ → test r2 ✗");
  });

  test("executedPath marks a route's pick, per run, including a run that ended at the decider", () => {
    const triage = (chose: string) => ({ kind: "chat" as const, id: "triage", round: 1, verdict: chose, chose, ok: true, summary: "" });
    const step = (id: string) => ({ kind: "delegate" as const, id, round: 1, ok: true, summary: "" });
    expect(executedPath({ steps: [triage("bug"), step("fix"), step("report")] })).toBe("triage ✓ ⑂bug → fix ✓ → report ✓");
    expect(executedPath({ steps: [triage("feature"), step("build"), step("report")] })).toBe("triage ✓ ⑂feature → build ✓ → report ✓");
    expect(executedPath({ steps: [triage("spam")] })).toBe("triage ✓ ⑂spam");
    // A free-text VERDICT on a non-route step is not a decision.
    expect(executedPath({ steps: [{ kind: "chat" as const, verdict: "LGTM", ok: true, summary: "" }] })).toBe("chat ✓");
  });

  test("attentionOf names the gate that stopped the run and its verdict; ok runs have none", () => {
    expect(attentionOf({ status: "needs-attention", steps })).toEqual({ at: "test r2", verdict: "FAIL", summary: "still failing" });
    expect(attentionOf({ status: "ok", steps })).toBeUndefined();
    // A later todo pass that succeeded doesn't hide where the gate stopped.
    const passed = { kind: "chat" as const, id: "pr", round: 1, ok: true, summary: "opened" };
    expect(attentionOf({ status: "needs-attention", steps: [...steps, passed] })?.at).toBe("test r2");
  });

  test("flattenRuns keeps the record's uuid for the attempts lookup", () => {
    const [run] = flattenRuns({ dev: { running: false, history: [{ id: "abc", startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:05:00Z", status: "ok", digest: "", steps: [] }] } });
    expect(run).toMatchObject({ id: "dev@2026-10-01T10:00:00Z", recordId: "abc" });
  });

  test("groupRuns counts a needs-attention run even when no step failed", () => {
    const [day] = groupRuns([{ routine: "dev", id: "dev@1", startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:05:00Z", status: "needs-attention", digest: "", steps }]);
    expect(day!.buckets[0]!.attention).toBe(1);
    expect(day!.buckets[0]!.needs).toBe(0);
  });

  // Local days, like groupRuns: a run a minute either side of local midnight lands in two buckets,
  // and the key names the same bucket groupRuns put it in.
  test("bucketKeyFor names the local-day bucket a run lands in", () => {
    const late = new Date(2026, 8, 21, 23, 59).toISOString();
    const early = new Date(2026, 8, 22, 0, 1).toISOString();
    expect(bucketKeyFor("r", late)).toBe("2026-09-21|r");
    expect(bucketKeyFor("r", early)).toBe("2026-09-22|r");
    const run = (startedAt: string) => ({ routine: "r", id: `r@${startedAt}`, startedAt, finishedAt: startedAt, status: "ok" as const, digest: "", steps: [] });
    const keys = groupRuns([run(early), run(late)]).flatMap((d) => d.buckets.map((b) => b.key));
    expect(keys).toEqual([bucketKeyFor("r", early), bucketKeyFor("r", late)]);
  });
});

describe("runFlowOverlay", () => {
  type Rec = RunRecord["steps"][number];
  const s = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep => ({ kind: "chat", id, instruction: "x", ...extra } as RoutineStep);
  const r = (id: string, extra: Partial<Rec> = {}): Rec => ({ kind: "chat", id, round: 1, ok: true, summary: "", ...extra });
  // Lit edges as readable `from>to:kind` strings, in edge order.
  const lit = (steps: RoutineStep[], recs: Rec[]): string[] | "drift" => {
    const o = runFlowOverlay({ steps: recs }, steps);
    if (o === "drift") return o;
    return stepFlow(steps).edges.flatMap((e, k) => (o.edges.has(k) ? [`${e.from}>${typeof e.to === "number" ? e.to : e.to}:${e.kind}`] : []));
  };
  const overlay = (steps: RoutineStep[], recs: Rec[]) => {
    const o = runFlowOverlay({ steps: recs }, steps);
    if (o === "drift") throw new Error("drift");
    return o;
  };
  const line = [s("a"), s("b"), s("c")];

  test("linear ok lights every hop and the end", () => {
    expect(lit(line, [r("a"), r("b"), r("c")])).toEqual(["0>1:flow", "1>2:flow", "2>end:flow"]);
    expect(overlay(line, [r("a"), r("b"), r("c")])).toMatchObject({ counts: [1, 1, 1], failed: [false, false, false] });
  });

  test("failed mid-way: the step is ✗, later steps never reached, no end", () => {
    const o = overlay(line, [r("a"), r("b", { ok: false })]);
    expect(o).toMatchObject({ counts: [1, 1, 0], failed: [false, true, false] });
    expect(lit(line, [r("a"), r("b", { ok: false })])).toEqual(["0>1:flow"]);
  });

  const gated = [s("impl"), s("test", { gate: { onFail: { goto: "impl", maxRounds: 3 } } }), s("ship")];
  test("gate loop round 2 lights the loop and counts ×2", () => {
    const recs = [r("impl"), r("test", { verdict: "FAIL" }), r("impl", { round: 2 }), r("test", { round: 2, verdict: "PASS" }), r("ship")];
    expect(lit(gated, recs)).toEqual(["0>1:flow", "1>2:pass", "1>0:loop", "2>end:flow"]);
    expect(overlay(gated, recs)).toMatchObject({ counts: [2, 2, 1], failed: [false, false, false] });
  });

  test("an exhausted loop leaves the gate ✗ and the rest dimmed", () => {
    const recs = [r("impl"), r("test", { verdict: "FAIL" }), r("impl", { round: 2 }), r("test", { round: 2, verdict: "FAIL" })];
    expect(overlay(gated, recs)).toMatchObject({ counts: [2, 2, 0], failed: [false, true, false] });
  });

  const routed = [
    s("triage", { route: { paths: [{ when: "bug", goto: "fix" }, { when: "spec", goto: "spec" }] } }),
    s("fix", { next: "end" }),
    s("spec"),
  ];
  test("a route lights the path it chose", () => {
    expect(lit(routed, [r("triage", { chose: "spec", verdict: "spec" }), r("spec")])).toEqual(["0>2:path", "2>end:flow"]);
    expect(overlay(routed, [r("triage", { chose: "spec" }), r("spec")]).counts).toEqual([1, 0, 1]);
  });

  test("no-match stop (needs-attention) lights the stop cap", () => {
    expect(lit(routed, [r("triage")])).toEqual(["0>stop:otherwise"]);
    const stopGate = [s("a", { gate: { onFail: "stop" } }), s("b")];
    expect(lit(stopGate, [r("a", { verdict: "FAIL" })])).toEqual(["0>stop:fail"]);
  });

  test("todo-driven runs union their passes and count ×N", () => {
    const recs = [r("a"), r("b"), r("c"), r("a"), r("b", { ok: false }), r("a"), r("b"), r("c")];
    const o = overlay(line, recs);
    expect(o).toMatchObject({ counts: [3, 3, 2], failed: [false, true, false] });
    expect(lit(line, recs)).toEqual(["0>1:flow", "1>2:flow", "2>end:flow"]);
  });

  test("legacy runs without ids map by position when the kinds line up", () => {
    const legacy: RoutineStep[] = [{ kind: "chat", instruction: "x" }, { kind: "command", command: "make" }];
    const recs: Rec[] = [{ kind: "chat", ok: true, summary: "" }, { kind: "command", ok: false, summary: "" }];
    expect(overlay(legacy, recs)).toMatchObject({ counts: [1, 1], failed: [false, true] });
    // A todo pass that failed starts the next pass over at step 1.
    const todo = (kind: "chat" | "command", ok: boolean): Rec => ({ kind, ok, summary: "[todo: t] out" });
    expect(overlay(legacy, [todo("chat", false), todo("chat", true), todo("command", true)]).counts).toEqual([2, 1]);
    expect(runFlowOverlay({ steps: [{ kind: "command", ok: true, summary: "" }] }, legacy)).toBe("drift");
    // A plain run has one pass: more records than steps means steps were removed since.
    expect(runFlowOverlay({ steps: [...recs, ...recs] }, legacy)).toBe("drift");
    expect(runFlowOverlay({ steps: [{ kind: "chat", ok: true, summary: "" }] }, gated)).toBe("drift");
  });

  const grouped = [s("plan"), s("lint"), s("test", { alongside: true }), s("review", { alongside: true }), s("merge")];
  test("a group run lights every fork and join, failed members included, with no drift", () => {
    const recs = [r("plan"), r("lint"), r("test", { ok: false }), r("review"), r("merge")];
    expect(lit(grouped, recs)).toEqual(["0>1:fork", "0>2:fork", "0>3:fork", "1>4:join", "2>4:join", "3>4:join", "4>end:flow"]);
    expect(overlay(grouped, recs)).toMatchObject({ counts: [1, 1, 1, 1, 1], failed: [false, false, true, false, false] });
    // A group that ends the run lights its joins to ● end.
    expect(lit(grouped.slice(0, 4), recs.slice(0, 4))).toContain("3>end:join");
    // Not the whole group, or out of step order: the record doesn't fit.
    expect(runFlowOverlay({ steps: [r("plan"), r("lint"), r("review"), r("test"), r("merge")] }, grouped)).toBe("drift");
    expect(runFlowOverlay({ steps: [r("plan"), r("lint"), r("test"), r("merge")] }, grouped)).toBe("drift");
  });

  test("a looped group counts rounds, and a member that errored then passed isn't ✗", () => {
    const looped = [s("lint"), s("test", { alongside: true }), s("check", { gate: { onFail: { goto: "lint", maxRounds: 3 } } }), s("ship")];
    const recs = [
      r("lint"), r("test", { ok: false }), r("check", { verdict: "FAIL" }),
      r("lint", { round: 2 }), r("test", { round: 2 }), r("check", { round: 2, verdict: "PASS" }), r("ship"),
    ];
    expect(overlay(looped, recs)).toMatchObject({ counts: [2, 2, 2, 1], failed: [false, false, false, false] });
    expect(lit(looped, recs)).toEqual(["0>2:join", "1>2:join", "2>3:pass", "2>0:loop", "3>end:flow"]);
  });

  test("a legacy record without ids drifts when the definition has a group", () => {
    const legacy: RoutineStep[] = [{ kind: "chat", instruction: "x" }, { kind: "chat", instruction: "y", alongside: true }];
    expect(runFlowOverlay({ steps: [{ kind: "chat", ok: true, summary: "" }, { kind: "chat", ok: true, summary: "" }] }, legacy)).toBe("drift");
  });

  test("executedPath brackets a group the definition shows", () => {
    const recs = [r("plan"), r("lint"), r("test", { ok: false }), r("review"), r("merge")];
    expect(executedPath({ steps: recs }, grouped)).toBe("plan ✓ → [lint ✓ | test ✗ | review ✓] → merge ✓");
    expect(executedPath({ steps: recs })).toBe("plan ✓ → lint ✓ → test ✗ → review ✓ → merge ✓");
  });

  test("drift: a deleted step or a re-pointed edge draws no highlight", () => {
    expect(runFlowOverlay({ steps: [r("a"), r("gone")] }, line)).toBe("drift");
    const repointed = [s("a", { next: "c" }), s("b"), s("c")];
    expect(runFlowOverlay({ steps: [r("a"), r("b"), r("c")] }, repointed)).toBe("drift");
    // The last step's chosen label no longer exists.
    const relabeled = [s("triage", { route: { paths: [{ when: "bug", goto: "end" }, { when: "chore", goto: "end" }] } })];
    expect(runFlowOverlay({ steps: [r("triage", { chose: "spec" })] }, relabeled)).toBe("drift");
  });
});

describe("attempt sessions", () => {
  // 1 chat · 2,4,6 continue one opencode session · 3,5 one claude session.
  const d = (id: string, cli: "opencode" | "claude", continues?: string): RoutineStep =>
    ({ kind: "delegate", id, skill: "", cli, instruction: "x", ...(continues ? { continues } : {}) });
  const steps: RoutineStep[] = [
    { kind: "chat", id: "a", instruction: "x" }, d("b", "opencode"), d("c", "claude"),
    d("d", "opencode", "b"), d("e", "claude", "c"), d("f", "opencode", "d"),
  ];
  const at = (stepIndex: number, resume?: string, output = "done") =>
    ({ stepIndex, output, ...(resume ? { resume, cli: resume.split(" ")[0] } : {}) });
  const run = [at(0), at(1, "opencode -s A"), at(2, "claude --resume B"), at(3, "opencode -s A"), at(4, "claude --resume B"), at(5, "opencode -s A")];

  test("groups attempts by resume string across steps, numbered by the session's first step", () => {
    expect(attemptSessions(run, steps)).toEqual([
      { last: true },
      { session: 2, last: false, next: 3 }, { session: 3, last: false, next: 4 },
      { session: 2, last: false, next: 5 }, { session: 3, last: true }, { session: 2, last: true },
    ]);
    expect(sessionSummary(run)).toBe("2 agent sessions · ↻2 steps 2→4→6 (opencode) · ↻3 steps 3→5 (claude)");
    expect(observedLanes(run, steps.length)).toEqual([0, 1, 2, 1, 2, 1]);
  });

  test("a gate loop's rounds share their session", () => {
    const loop = [at(1, "claude --resume X"), at(2), at(1, "claude --resume X"), at(2)];
    expect(attemptSessions(loop).map((s) => s.session)).toEqual([2, undefined, 2, undefined]);
    expect(sessionSummary(loop)).toBe("1 agent session · ↻2 steps 2 (claude)");
  });

  test("two todos in one run are separate sessions", () => {
    const two = [at(1, "opencode -s A"), at(3, "opencode -s A"), at(1, "opencode -s C"), at(3, "opencode -s C")];
    expect(attemptSessions(two, steps)).toEqual([
      { session: 2, last: false, next: 1 }, { session: 2, last: true },
      { session: 2, last: false, next: 3 }, { session: 2, last: true },
    ]);
    expect(sessionSummary(two)).toBe("2 agent sessions · ↻2 steps 2→4 (opencode) · ↻2 steps 2→4 (opencode)");
  });

  test("a step that fell back to a new session is marked fresh", () => {
    // Step 2 failed with no session, so step 4 started its own.
    const fallback = [at(1), at(3, "opencode -s D"), at(5, "opencode -s D")];
    expect(attemptSessions(fallback, steps)).toEqual([{ last: true }, { session: 4, last: false, next: 2, fresh: true }, { session: 4, last: true }]);
    // The runner's own note says so even without the definition.
    const noted = [at(3, "opencode -s D", "(No earlier session from b to continue — started fresh.)\nok")];
    expect(attemptSessions(noted)).toEqual([{ last: true, fresh: true }]);
  });

  test("an attempt with no resume is never grouped", () => {
    expect(attemptSessions([at(1), at(3)], steps.map((s) => ({ ...s, continues: undefined }) as RoutineStep))).toEqual([{ last: true }, { last: true }]);
    expect(sessionSummary([at(1), at(3)])).toBeUndefined();
    expect(observedLanes([at(1), at(3)], 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a definition edited after the run doesn't regroup it", () => {
    const edited = steps.map((s) => (s.kind === "delegate" ? { ...s, continues: undefined } : s)) as RoutineStep[];
    const strip = (xs: ReturnType<typeof attemptSessions>) => xs.map(({ fresh: _f, ...rest }) => rest);
    expect(strip(attemptSessions(run, edited))).toEqual(strip(attemptSessions(run, steps)));
    expect(attemptSessions(run, edited).some((s) => s.fresh)).toBe(false);
  });
});
