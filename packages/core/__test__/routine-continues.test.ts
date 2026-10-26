// packages/core/__test__/routine-continues.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRoutine, type DelegateStepRequest, type RoutineRunnerDeps } from "../src/routine-runner.js";
import { describeRoutineError, usesGates, type Routine, type RoutineStep } from "../src/routine-store.js";
import { continueTargets, stepContinueCaptions, stepEdgeProblems, stepLanes } from "../src/routine-graph.js";
import { createRoutineHost, formatReceipts, type RoutineHostDeps } from "../src/routine-host.js";
import { parseBrief, type BriefContext, type TodoItem } from "../src/index.js";

const routine = (steps: RoutineStep[], over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {}, ...over });

const step = (id: string, extra: Partial<RoutineStep> = {}): RoutineStep =>
  ({ kind: "delegate", id, skill: "s", cli: "claude", instruction: `[${id}] do ${id}`, ...extra }) as RoutineStep;

/** Each call gets a new session `sess-<id>-<n>`, or keeps the one it resumed. `answers[id]` is
 * consumed in order (last repeats); `throws` lists step ids whose call rejects. */
function fakeDelegate(answers: Record<string, string[]> = {}, throws: string[] = []) {
  const calls: DelegateStepRequest[] = [];
  let n = 0;
  const delegate: RoutineRunnerDeps["delegate"] = async (req) => {
    calls.push(req);
    const id = /^\[(\w[\w-]*)\]/.exec(req.instruction)?.[1] ?? "?";
    if (throws.includes(id)) throw new Error(`${id} broke`);
    const list = answers[id] ?? ["done"];
    const output = list.length > 1 ? list.shift()! : list[0]!;
    return { output, cli: req.cli ?? "claude", sessionId: req.resume?.sessionId ?? `sess-${id}-${++n}` };
  };
  return { delegate, calls };
}

const deps = (delegate: RoutineRunnerDeps["delegate"], over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps => ({
  chat: async () => ({ content: "digest", toolCalls: [] }), model: "gpt-test", delegate, tools: [],
  findSkill: () => undefined, now: () => new Date("2026-10-25T06:00:00Z"), ...over,
});

const resumeOf = (calls: DelegateStepRequest[], id: string, nth = 0) =>
  calls.filter((c) => c.instruction.startsWith(`[${id}]`))[nth]?.resume;

describe("continues at run time", () => {
  it("B continuing A gets A's session; continues alone doesn't turn on graph mode", async () => {
    const f = fakeDelegate();
    const steps = [step("a"), step("b", { continues: "a" })];
    expect(usesGates(steps)).toBe(false);
    const res = await runRoutine(routine(steps), deps(f.delegate));
    expect(resumeOf(f.calls, "a")).toBeUndefined();
    expect(resumeOf(f.calls, "b")).toEqual({ cli: "claude", sessionId: "sess-a-1" });
    expect(res.record.steps.every((s) => s.round === undefined)).toBe(true);
  });

  it("a looping B resumes its own previous round", async () => {
    const f = fakeDelegate({ check: ["bad\nVERDICT: FAIL", "good\nVERDICT: PASS"] });
    // Every call reports a new id, so the lane's newest session is visible.
    let n = 0;
    const delegate: RoutineRunnerDeps["delegate"] = async (req) => {
      const r = await f.delegate(req);
      return typeof r === "string" ? r : { ...r, sessionId: `s${++n}` };
    };
    const res = await runRoutine(routine([
      step("a"), step("b", { continues: "a" }), step("check", { gate: { onFail: { goto: "b" } } }),
    ]), deps(delegate));
    expect(res.record.status).toBe("ok");
    // a → s1, b round 1 → s2, check → s3, b round 2 resumes s2.
    expect(resumeOf(f.calls, "b", 0)).toEqual({ cli: "claude", sessionId: "s1" });
    expect(resumeOf(f.calls, "b", 1)).toEqual({ cli: "claude", sessionId: "s2" });
  });

  it("C continuing A after B continued A gets B's newest id; A→B→C is one lane", async () => {
    let n = 0;
    const calls: DelegateStepRequest[] = [];
    const delegate: RoutineRunnerDeps["delegate"] = async (req) => { calls.push(req); return { output: "ok", cli: "claude", sessionId: `s${++n}` }; };
    await runRoutine(routine([step("a"), step("b", { continues: "a" }), step("c", { continues: "a" })]), deps(delegate));
    expect(resumeOf(calls, "c")).toEqual({ cli: "claude", sessionId: "s2" });

    const chain = [step("a"), step("b", { continues: "a" }), step("c", { continues: "b" })];
    expect(stepLanes(chain)).toEqual([0, 0, 0]);
    calls.length = 0; n = 0;
    await runRoutine(routine(chain), deps(delegate));
    expect(resumeOf(calls, "c")).toEqual({ cli: "claude", sessionId: "s2" });
  });

  it("a failed target means a fresh run with the notice", async () => {
    const f = fakeDelegate({}, ["a"]);
    const res = await runRoutine(routine([step("a"), step("b", { continues: "a" })]), deps(f.delegate));
    expect(resumeOf(f.calls, "b")).toBeUndefined();
    expect(res.results[1]!.output).toMatch(/^\(No earlier session from a to continue — started fresh\.\)\ndone/);
  });

  it("a target skipped by a route means a fresh run with the notice", async () => {
    const f = fakeDelegate();
    const res = await runRoutine(routine([
      { kind: "chat", id: "pick", instruction: "pick", route: { paths: [{ when: "x", goto: "a" }, { when: "y", goto: "b" }] } },
      step("a", { next: "end" }),
      step("b", { continues: "a" }),
    ]), deps(f.delegate, { chat: async () => ({ content: "ROUTE: y", toolCalls: [] }) }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.resume).toBeUndefined();
    expect(res.results.at(-1)!.output).toMatch(/^\(No earlier session from a to continue/);
  });

  it("two todos never share a lane", async () => {
    const f = fakeDelegate();
    const q: TodoItem[] = [1, 2].map((k) => ({ id: `t${k}`, routine: "r", text: `todo ${k}`, status: "running", createdAt: "" }) as TodoItem);
    await runRoutine(routine([step("a"), step("b", { continues: "a" })], { todoDriven: true }), deps(f.delegate, {
      todos: { claim: async () => q.shift(), setStatus: async () => {} },
    }));
    expect(resumeOf(f.calls, "a", 1)).toBeUndefined();
    expect(resumeOf(f.calls, "b", 0)).toEqual({ cli: "claude", sessionId: "sess-a-1" });
    expect(resumeOf(f.calls, "b", 1)).toEqual({ cli: "claude", sessionId: "sess-a-2" });
  });

  it("a join continues a group member", async () => {
    const f = fakeDelegate();
    const res = await runRoutine(routine([
      step("a"), step("b", { alongside: true }), step("j", { continues: "b" }),
    ]), deps(f.delegate));
    expect(res.record.status).toBe("ok");
    expect(resumeOf(f.calls, "j")).toEqual({ cli: "claude", sessionId: "sess-b-2" });
  });
});

describe("continues validation", () => {
  const err = (steps: unknown[]): string | null =>
    describeRoutineError({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {} });

  it("accepts an earlier delegate on the same cli and project", () => {
    expect(err([step("a", { project: "/p" }), step("b", { project: "/p", continues: "a" })])).toBeNull();
    expect(err([step("a"), step("b", { continues: "a" }), step("c", { continues: "b" })])).toBeNull();
  });

  it("rejects it on chat and command steps, and a malformed id", () => {
    expect(err([step("a"), { kind: "chat", instruction: "x", continues: "a" }])).toMatch(/step 2: only a delegate step can continue/);
    expect(err([step("a"), { kind: "command", command: "ls", continues: "a" }])).toMatch(/step 2: only a delegate step can continue/);
    expect(err([step("a"), step("b", { continues: "Bad Id" })])).toMatch(/step 2 has an invalid continues id/);
  });

  it("rejects unknown, self, forward, chat and command targets", () => {
    expect(err([step("a", { continues: "zz" })])).toMatch(/step 1: continues step "zz" doesn't exist/);
    expect(err([step("a", { continues: "a" })])).toMatch(/step 1 can't continue its own session/);
    expect(err([step("a", { continues: "b" }), step("b")])).toMatch(/step 1: continues must point to an earlier step/);
    expect(err([{ kind: "chat", id: "a", instruction: "x" }, step("b", { continues: "a" })])).toMatch(/step 2: step 1 is a chat step/);
    expect(err([{ kind: "command", id: "a", command: "ls" }, step("b", { continues: "a" })])).toMatch(/step 2: step 1 is a command step/);
  });

  it("needs the same pinned cli and the same project", () => {
    expect(err([step("a", { cli: "codex" }), step("b", { continues: "a" })])).toMatch(/step 2: step 1 runs on codex, this step on claude/);
    expect(err([step("a", { cli: undefined }), step("b", { continues: "a" })])).toMatch(/step 2: pin the same coding agent/);
    expect(err([step("a"), step("b", { cli: undefined, continues: "a" })])).toMatch(/step 2: pin the same coding agent/);
    expect(err([step("a", { project: "/p" }), step("b", { continues: "a" })])).toMatch(/step 2: step 1 works in a different project/);
  });

  it("rejects a member continuing a sibling, and two members sharing a lane — directly or through a chain", () => {
    expect(err([step("a"), step("b", { alongside: true, continues: "a" })])).toMatch(/step 2 runs alongside step 1, so it can't continue/);
    expect(err([step("x"), step("a", { continues: "x" }), step("b", { alongside: true, continues: "x" })]))
      .toMatch(/step 3: step 2 runs alongside it in the same session/);
    expect(err([step("x"), step("y", { continues: "x" }), step("a", { continues: "x" }), step("b", { alongside: true, continues: "y" })]))
      .toMatch(/step 4: step 3 runs alongside it in the same session/);
    expect(err([step("x"), step("y"), step("a", { continues: "x" }), step("b", { alongside: true, continues: "y" })])).toBeNull();
  });

  it("flags a dangling id after a delete or reorder", () => {
    const steps = [step("a"), step("b", { continues: "a" })];
    expect(stepEdgeProblems(steps)).toEqual([null, null]);
    expect(stepEdgeProblems(steps.slice(1))).toEqual(['step 1: continues step "a" doesn\'t exist']);
    expect(stepEdgeProblems([steps[1]!, steps[0]!])[0]).toMatch(/continues must point to an earlier step/);
  });
});

describe("continue helpers", () => {
  it("continueTargets lists earlier delegates with the validator's wording", () => {
    const steps = [step("a"), { kind: "chat", id: "c", instruction: "x" } as RoutineStep, step("b", { cli: "codex" }), step("d")];
    expect(continueTargets(steps, 3)).toEqual([
      { index: 0, id: "a", problem: null },
      { index: 2, id: "b", problem: "step 4: step 3 runs on codex, this step on claude — a session only continues on the same coding agent" },
    ]);
  });

  it("stepContinueCaptions names where a session continues, and skips a rejected continues", () => {
    const steps = [step("a"), step("b"), step("c", { continues: "a" }), step("d", { continues: "c" }), step("e", { continues: "zz" })];
    expect(stepContinueCaptions(steps)).toEqual([
      "its session continues in steps 3, 4", null, "continues step 1's session", "continues step 3's session", null,
    ]);
  });
});

describe("continues on the host", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-continues-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const host = (delegateStep: RoutineHostDeps["delegateStep"]) => createRoutineHost({
    dir, converse: async () => ({ content: "the digest", toolCalls: [] }), getModel: () => "gpt-test", delegateStep,
    commandStep: async () => ({ exitCode: 0, output: "ok" }), tools: [], loadSkills: async () => [], memories: async () => [],
    getRoutineDigestContext: () => false, newId: () => "id-1",
  });

  it("holds the scratch across steps, removes it at the end, and prints one footer line per session", async () => {
    const project = join(dir, "kubernetes");
    const scratch = join(dir, "scratch-todo");
    const seen: boolean[] = [];
    let n = 0;
    const h = host(async (req, onSession, hold) => {
      seen.push(existsSync(scratch));
      if (hold) { mkdirSync(scratch, { recursive: true }); hold.scratch.add(scratch); }
      const sessionId = req.resume?.sessionId ?? `s${++n}`;
      onSession?.("claude", sessionId, project);
      return { output: "out", cli: "claude", sessionId };
    });
    const res = await h.runOneRoutine(routine([
      step("a", { project }), step("b", { project }), step("c", { project, continues: "a" }), step("d", { project, continues: "c" }),
    ]));
    expect(seen).toEqual([false, true, true, true]);
    expect(existsSync(scratch)).toBe(false);
    expect(res.digest).toContain("Resume a delegate session:\nsteps 1→3→4 (kubernetes) — claude --resume s1\nstep 2 (kubernetes) — claude --resume s2");
  });

  it("formats a gate loop's repeated session as one line", () => {
    expect(formatReceipts([
      { steps: [{ index: 1, round: 1 }, { index: 1, round: 2 }], project: "workspace", cli: "opencode", sessionId: "ses_1" },
      { steps: [{ index: 2, round: 2 }], project: "workspace", cli: "opencode", sessionId: "ses_2" },
    ])).toEqual(["step 2 (workspace) — opencode -s ses_1", "step 3 round 2 (workspace) — opencode -s ses_2"]);
  });
});

describe("parseBrief and continues", () => {
  const ctx: BriefContext = { tools: [], projects: [], skills: [{ name: "s", description: "d" }], clis: ["claude", "codex"] };
  const brief = (steps: unknown[]) => parseBrief(JSON.stringify({ name: "x", trigger: "schedule", cron: "0 8 * * *", steps, sinks: { note: true } }), ctx);

  it("keeps a valid continues through a refine and drops a rejected one, never the step", () => {
    const kept = brief([step("a"), step("b", { continues: "a" })]);
    expect(kept.steps[1]).toMatchObject({ id: "b", continues: "a" });
    const dropped = brief([step("a", { cli: "codex" }), step("b", { continues: "a" }), step("c", { continues: "zz" })]);
    expect(dropped.steps).toHaveLength(3);
    expect(dropped.steps.map((s) => s.continues)).toEqual([undefined, undefined, undefined]);
    expect(brief([{ kind: "chat", instruction: "x", continues: "a" }]).steps[0]).not.toHaveProperty("continues");
  });
});
