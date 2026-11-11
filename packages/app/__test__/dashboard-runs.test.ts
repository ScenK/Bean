import { describe, expect, test } from "vitest";
import { attemptSessions, attentionOf, bucketKeyFor, executedPath, flattenRuns, groupRuns, reviewRuns, sessionSummary, splitSteps, stepLabel, unreadRuns } from "../src/renderer/components/dashboard/runs.js";
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
  });

  test("a definition edited after the run doesn't regroup it", () => {
    const edited = steps.map((s) => (s.kind === "delegate" ? { ...s, continues: undefined } : s)) as RoutineStep[];
    const strip = (xs: ReturnType<typeof attemptSessions>) => xs.map(({ fresh: _f, ...rest }) => rest);
    expect(strip(attemptSessions(run, edited))).toEqual(strip(attemptSessions(run, steps)));
    expect(attemptSessions(run, edited).some((s) => s.fresh)).toBe(false);
  });
});
