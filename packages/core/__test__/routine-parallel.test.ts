// packages/core/__test__/routine-parallel.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRoutine, type DelegateStepRequest, type RoutineRunnerDeps } from "../src/routine-runner.js";
import { createRoutineHost, type RoutineHostDeps, type RoutineHostStatus } from "../src/routine-host.js";
import type { Routine, RoutineStep } from "../src/routine-store.js";
import type { StepAttempt } from "../src/step-attempts.js";

const routine = (steps: RoutineStep[]): Routine => ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {} });
const step = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep =>
  ({ kind: "delegate", id, instruction: `[${id}] do ${id}`, ...extra }) as RoutineStep;
const idOf = (req: DelegateStepRequest): string => /^\[([\w-]+)\]/.exec(req.instruction)?.[1] ?? "?";

/** implement → lint ‖ test ‖ review → triage */
const flow = (triage: Partial<RoutineStep> = {}): RoutineStep[] => [
  step("implement"), step("lint"), step("test", { alongside: true }), step("review", { alongside: true }), step("triage", triage),
];

const deps = (delegate: RoutineRunnerDeps["delegate"], over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps => ({
  chat: async () => ({ content: "digest", toolCalls: [] }), model: "gpt-test", delegate, tools: [],
  findSkill: () => undefined, now: () => new Date("2026-10-25T06:00:00Z"), ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("parallel groups", () => {
  it("starts every member before any finishes and commits in step order despite a reverse finish", async () => {
    const gates = { lint: deferred<string>(), test: deferred<string>(), review: deferred<string>() };
    const started: string[] = [];
    const attempts: StepAttempt[] = [];
    const run = runRoutine(routine(flow()), deps(async (req) => {
      const id = idOf(req);
      started.push(id);
      return id in gates ? gates[id as keyof typeof gates].promise : `${id} out`;
    }, { recordAttempt: (a) => attempts.push(a) }));
    await tick();
    expect(started).toEqual(["implement", "lint", "test", "review"]);
    gates.review.resolve("review out");
    await tick();
    gates.test.resolve("test out");
    await tick();
    expect(attempts.map((a) => a.stepIndex)).toEqual([0]); // lint still running: nothing past it lands
    gates.lint.resolve("lint out");
    const res = await run;
    expect(attempts.map((a) => a.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(res.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(res.record.steps.map((s) => s.id)).toEqual(["implement", "lint", "test", "review", "triage"]);
    expect(res.record.status).toBe("ok");
  });

  it("hands the join every member (FAILED ones too), siblings see only what ran before the group, and the run ends failed", async () => {
    const reqs: DelegateStepRequest[] = [];
    const res = await runRoutine(routine(flow()), deps(async (req) => {
      reqs.push(req);
      if (idOf(req) === "test") throw new Error("test timed out after 15 minutes");
      return `${idOf(req)} out`;
    }));
    const by = (id: string) => reqs.find((r) => idOf(r) === id)!;
    for (const id of ["lint", "test", "review"]) {
      expect(by(id).priorOutputs).toContain("implement out");
      expect(by(id).priorOutputs).not.toMatch(/lint out|review out|timed out/);
    }
    const join = by("triage").priorOutputs;
    expect(join).toContain("--- step 2 (delegate, ok) ---\nlint out");
    expect(join).toContain("--- step 3 (delegate, FAILED) ---\ntest timed out after 15 minutes");
    expect(join).toContain("--- step 4 (delegate, ok) ---\nreview out");
    expect(res.record.status).toBe("failed");
  });

  it("a gated join that loops back re-runs the whole group with the same feedback and filtered priors, then ends ok", async () => {
    const reqs: DelegateStepRequest[] = [];
    let triage = 0;
    const steps = flow({ gate: { onFail: { goto: "lint" } } });
    const res = await runRoutine(routine(steps), deps(async (req) => {
      reqs.push(req);
      const id = idOf(req);
      if (id === "triage") return ++triage === 1 ? "lint broke\nVERDICT: FAIL" : "all good\nVERDICT: PASS";
      // test fails in round 1 only — its latest attempt is ok, so the run is too.
      if (id === "test" && req.round === 1) throw new Error("flaky");
      return `${id} out r${req.round}`;
    }));
    const round2 = reqs.filter((r) => ["lint", "test", "review"].includes(idOf(r)) && r.round === 2);
    expect(round2).toHaveLength(3);
    const fb = round2.map((r) => r.instruction.slice(r.instruction.indexOf("\n\nThe check")));
    expect(new Set(fb).size).toBe(1);
    expect(fb[0]).toContain("lint broke");
    for (const r of round2) {
      expect(r.priorOutputs).toContain("implement out");
      expect(r.priorOutputs).not.toMatch(/lint out|review out|flaky/);
    }
    expect(res.record.status).toBe("ok");
  });

  it("a failed member outranks a later needs-attention and keeps its text", async () => {
    const res = await runRoutine(routine(flow({ gate: { onFail: "stop" } })), deps(async (req) => {
      if (idOf(req) === "lint") throw new Error("lint crashed");
      return idOf(req) === "triage" ? "no\nVERDICT: FAIL" : "ok";
    }));
    expect(res.record.status).toBe("failed");
    expect(res.digest).toMatch(/^Needs attention: stopped at triage/);
  });

  it("never starts a group that doesn't fit the execution budget", async () => {
    const steps = [
      ...Array.from({ length: 48 }, (_, i) => step(`s${i}`)),
      step("lint"), step("test", { alongside: true }), step("review", { alongside: true }), step("triage"),
    ];
    const ids: string[] = [];
    const res = await runRoutine(routine(steps), deps(async (req) => { ids.push(idOf(req)); return "ok"; }));
    expect(ids).toHaveLength(48);
    expect(res.record.status).toBe("needs-attention");
    expect(res.digest).toMatch(/stopped at lint — the run hit its 50-step limit/);
  });
});

describe("parallel groups on the host", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-parallel-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const host = (over: Partial<RoutineHostDeps>) => {
    const status: RoutineHostStatus[] = [];
    const h = createRoutineHost({
      dir, converse: async () => ({ content: "the digest", toolCalls: [] }), getModel: () => "gpt-test",
      delegateStep: async () => ({ output: "out", cli: "claude" }),
      commandStep: async () => ({ exitCode: 0, output: "ok" }),
      tools: [], loadSkills: async () => [], memories: async () => [], getRoutineDigestContext: () => false,
      onStatus: (e) => status.push(e), newId: () => "id-1", ...over,
    });
    return { ...h, status };
  };

  it("labels receipts from the request even when session callbacks land late, and shows one counting group line", async () => {
    // Both members start; their sessions report only after both are running, in reverse.
    const waiting: (() => void)[] = [];
    let n = 0;
    const sid = (k: number): string => `00000000-0000-0000-0000-00000000000${k}`;
    const h = host({
      delegateStep: (req, onSession) => new Promise((resolve) => {
        const k = ++n;
        waiting.push(() => { onSession?.("claude", sid(k), join(dir, "workspace")); resolve({ output: `${req.stepIndex} out`, cli: "claude" }); });
        if (waiting.length === 2) waiting.splice(0).reverse().forEach((f) => f());
      }),
      commandStep: async () => (n <= 2 ? { exitCode: 1, output: "fail" } : { exitCode: 0, output: "pass" }),
    });
    const res = await h.runOneRoutine(routine([
      { kind: "delegate", id: "a", skill: "lint", instruction: "x" },
      { kind: "delegate", id: "b", skill: "test", instruction: "y", alongside: true },
      { kind: "command", id: "j", command: "check", gate: { onFail: { goto: "a" } } },
    ]));
    expect(res.record.status).toBe("ok");
    for (const label of ["step 1", "step 2", "step 1 round 2", "step 2 round 2"]) {
      expect(res.digest).toMatch(new RegExp(`\\n${label} \\(workspace\\) — claude --resume`));
    }
    const lines = h.status.flatMap((e) => (e.type === "step" ? [e.line] : []));
    expect(lines.slice(0, 3)).toEqual(["⫴ lint · test (2 of 2 left)", "⫴ lint · test (1 of 2 left)", "⫴ lint · test (0 of 2 left)"]);
    expect(lines).toContain("⫴ lint · test (2 of 2 left) · round 2");
  });

  it("names the failed members on the finish line", async () => {
    const h = host({ delegateStep: async (req) => { if (req.stepIndex === 1) throw new Error("boom"); return { output: "out" }; } });
    await h.runOneRoutine(routine([
      { kind: "delegate", skill: "lint", instruction: "x" },
      { kind: "delegate", skill: "test", instruction: "y", alongside: true },
      { kind: "chat", instruction: "triage" },
    ]));
    expect(h.status.at(-1)).toMatchObject({ type: "finish", state: "failed", line: "Finished with a failed step — test failed" });
  });
});
