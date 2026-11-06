// packages/core/__test__/routine-stop.test.ts — a sprout run's Stop (#709).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runShellCommand } from "../src/command-step.js";
import { dbFile, runsDir } from "../src/config.js";
import { createRoutineHost, type RoutineHostStatus } from "../src/routine-host.js";
import { runRoutine, type RoutineRunnerDeps } from "../src/routine-runner.js";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../src/routine-scheduler.js";
import { makeRoutineSteps } from "../src/routine-steps.js";
import { addTodo, listTodos } from "../src/todo-store.js";
import type { Routine, RoutineRunResult, RoutineState, RoutineStep, TodoItem, TodoStatus } from "../src/index.js";

const routine = (steps: RoutineStep[], over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {}, ...over });
const todo = (id: string): TodoItem => ({ id, routine: "r", text: `task ${id}`, status: "pending", createdAt: "x", order: 0 });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A step impl that runs until the signal aborts, then rejects like the real adapters. */
const untilStopped = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Stopped by you")), { once: true }));

function deps(over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps & { chatCalls: () => number } {
  let calls = 0;
  return {
    chat: async () => { calls++; return { content: "chat out", toolCalls: [] }; },
    model: "m", tools: [], findSkill: () => undefined, now: () => new Date("2026-11-05T06:00:00Z"),
    delegate: async () => "delegated",
    command: async () => ({ exitCode: 0, output: "ok" }),
    ...over,
    chatCalls: () => calls,
  };
}

describe("runRoutine stop", () => {
  it("stops during a delegate step: no further steps, fixed digest, status failed", async () => {
    const ctl = new AbortController();
    const d = deps({ signal: ctl.signal, delegate: (req) => untilStopped(req.signal) });
    const run = runRoutine(routine([{ kind: "delegate", id: "build", instruction: "x" }, { kind: "chat", instruction: "y" }]), d);
    await tick();
    ctl.abort();
    const res = await run;
    expect(res.stopped).toBe(true);
    expect(res.record.status).toBe("failed");
    expect(res.digest).toBe("Stopped by you at step 1 (build)");
    expect(d.chatCalls()).toBe(0); // neither step 2 nor composeDigest
    expect(res.results.map((r) => r.ok)).toEqual([false]);
  });

  it("stops during a command step", async () => {
    const ctl = new AbortController();
    const d = deps({ signal: ctl.signal, command: (req) => untilStopped(req.signal) });
    const run = runRoutine(routine([{ kind: "command", command: "sleep 99" }, { kind: "chat", instruction: "y" }]), d);
    await tick();
    ctl.abort();
    const res = await run;
    expect(res).toMatchObject({ stopped: true, digest: "Stopped by you at step 1 (sleep 99)", record: { status: "failed" } });
    expect(d.chatCalls()).toBe(0);
  });

  it("stops during a chat step even while the model call hangs; its late result is dropped", async () => {
    const ctl = new AbortController();
    let late!: (v: { content: string; toolCalls: [] }) => void;
    const d = deps({ signal: ctl.signal, chat: () => new Promise((r) => { late = r; }) });
    const run = runRoutine(routine([{ kind: "chat", instruction: "think" }, { kind: "delegate", instruction: "z" }]), {
      ...d, delegate: vi.fn(async () => "never"),
    });
    await tick();
    ctl.abort();
    const res = await run;
    late({ content: "too late", toolCalls: [] });
    expect(res).toMatchObject({ stopped: true, digest: "Stopped by you at step 1 (think)" });
    expect(res.results[0]?.output).toBe("Stopped by you");
  });

  it("a killed command on a gate with onFail.goto does not loop back", async () => {
    const ctl = new AbortController();
    const delegate = vi.fn(async () => "built");
    // Even if an adapter reported the kill as an exit code, the stop wins over the gate.
    const command = vi.fn(async () => { ctl.abort(); return { exitCode: 137, output: "Killed" }; });
    const res = await runRoutine(routine([
      { kind: "delegate", id: "impl", instruction: "x" },
      { kind: "command", id: "check", command: "test", gate: { onFail: { goto: "impl", maxRounds: 3 } } },
    ]), deps({ signal: ctl.signal, delegate, command }));
    expect(delegate).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ stopped: true, digest: "Stopped by you at step 2 (check)" });
  });

  it("aborts every parallel group member; the join and later steps don't run", async () => {
    const ctl = new AbortController();
    const started: string[] = [];
    const res = runRoutine(routine([
      { kind: "delegate", id: "a", instruction: "a" },
      { kind: "delegate", id: "b", instruction: "b", alongside: true },
      { kind: "delegate", id: "join", instruction: "join" },
    ]), deps({ signal: ctl.signal, delegate: (req) => { started.push(req.instruction); return untilStopped(req.signal); } }));
    await tick();
    expect(started).toEqual(["a", "b"]);
    ctl.abort();
    const out = await res;
    expect(started).toEqual(["a", "b"]);
    expect(out.results.map((r) => r.ok)).toEqual([false, false]);
    expect(out.digest).toBe("Stopped by you at step 1 (a)");
  });

  it("serial drain: the in-flight todo fails, the rest stay pending, nothing more is claimed", async () => {
    const ctl = new AbortController();
    const queue = [todo("1"), todo("2"), todo("3")];
    const claim = vi.fn(async () => queue.shift());
    const statuses: [string, TodoStatus, string?][] = [];
    const run = runRoutine(routine([{ kind: "delegate", instruction: "x" }], { todoDriven: true }), deps({
      signal: ctl.signal, delegate: (req) => untilStopped(req.signal),
      todos: { claim, setStatus: async (id, st, sum) => { statuses.push([id, st, sum]); } },
    }));
    await tick();
    ctl.abort();
    expect((await run).stopped).toBe(true);
    expect(statuses).toEqual([["1", "failed", "Stopped by you"]]);
    expect(claim).toHaveBeenCalledOnce();
    expect(queue.map((t) => t.id)).toEqual(["2", "3"]);
  });

  it("serial drain: a todo whose claim returns after the stop is failed unrun", async () => {
    const ctl = new AbortController();
    const queue = [todo("1"), todo("2")];
    const delegate = vi.fn(async () => "done");
    const statuses: [string, TodoStatus, string?][] = [];
    let n = 0;
    const claim = vi.fn(async () => { if (n++ === 1) ctl.abort(); return queue.shift(); });
    const res = await runRoutine(routine([{ kind: "delegate", instruction: "x" }], { todoDriven: true }), deps({
      signal: ctl.signal, delegate, todos: { claim, setStatus: async (id, st, sum) => { statuses.push([id, st, sum]); } },
    }));
    expect(delegate).toHaveBeenCalledOnce(); // todo 1 only
    expect(statuses).toEqual([["1", "done", "done"], ["2", "failed", "Stopped by you"]]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(res.stopped).toBe(true);
  });

  it("a stop after the last step completed is ignored", async () => {
    const ctl = new AbortController();
    let n = 0;
    const res = await runRoutine(routine([{ kind: "chat", instruction: "a" }, { kind: "chat", instruction: "b" }]), deps({
      signal: ctl.signal,
      // Third call = composeDigest, after the step loop finished.
      chat: async () => { if (++n === 3) ctl.abort(); return { content: `out ${n}`, toolCalls: [] }; },
    }));
    expect(res.stopped).toBeUndefined();
    expect(res.record.status).toBe("ok");
    expect(res.digest).toBe("out 3");
  });
});

describe("runShellCommand stop", () => {
  it("kills the group on abort and rejects instead of resolving an exit code", async () => {
    const ctl = new AbortController();
    const run = runShellCommand("sleep 30", { cwd: tmpdir(), env: process.env, timeoutMs: 60_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(run).rejects.toThrow("Stopped by you");
  });

  it("spawns nothing when already aborted", async () => {
    const spawnFn = vi.fn();
    await expect(runShellCommand("true", { cwd: tmpdir(), env: process.env, timeoutMs: 1000, signal: AbortSignal.abort(), spawnFn }))
      .rejects.toThrow("Stopped by you");
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("delegate adapter stop", () => {
  const records = (dir: string): string[] => { try { return readdirSync(runsDir(dir)); } catch { return []; } };

  it("settles on cancel and releases its run record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-stop-"));
    const project = mkdtempSync(join(tmpdir(), "bean-stop-proj-"));
    const ctl = new AbortController();
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "", selectCli: () => ({ cli: "claude" }),
      spawnFn: (_c, _a, cwd) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    });
    const run = delegateStep({ projectPath: project, instruction: "x", priorOutputs: "", signal: ctl.signal });
    expect(records(dir)).toHaveLength(1);
    ctl.abort();
    await expect(run).rejects.toThrow("Stopped by you");
    expect(records(dir)).toEqual([]);
  });

  it("spawns nothing when aborted before the spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-stop-"));
    const spawnFn = vi.fn();
    const { delegateStep } = makeRoutineSteps({ dir, path: "", selectCli: () => ({ cli: "claude" }), spawnFn });
    await expect(delegateStep({ projectPath: dir, instruction: "x", priorOutputs: "", signal: AbortSignal.abort() })).rejects.toThrow("Stopped by you");
    expect(spawnFn).not.toHaveBeenCalled();
    expect(records(dir)).toEqual([]);
  });
});

describe("scheduler stopRuns", () => {
  /** runRoutine fake: runs until its signal aborts (then reports a stopped run) or `finish()`. */
  function liveRuns() {
    const finishers: (() => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const result = (stopped: boolean): RoutineRunResult => {
      const record = { startedAt: "a", finishedAt: "b", status: stopped ? "failed" as const : "ok" as const, digest: "d", steps: [] };
      return { record, digest: "d", results: [], ...(stopped ? { stopped: true as const } : {}) };
    };
    const runRoutine = vi.fn((_r: Routine, _t?: TodoItem, signal?: AbortSignal) => {
      signals.push(signal);
      return new Promise<RoutineRunResult>((resolve) => {
        if (signal?.aborted) { resolve(result(true)); return; }
        signal?.addEventListener("abort", () => resolve(result(true)), { once: true });
        finishers.push(() => resolve(result(false)));
      });
    });
    return { runRoutine, signals, finishAll: () => { for (const f of finishers.splice(0)) f(); } };
  }

  function setup(r: Routine, over: Partial<RoutineSchedulerDeps> = {}) {
    let states: Record<string, RoutineState> = {};
    const runs = liveRuns();
    const deps: RoutineSchedulerDeps = {
      loadRoutines: async () => [r], loadStates: async () => states, saveStates: async (s) => { states = s; },
      runRoutine: runs.runRoutine, deliverDigest: vi.fn(async () => {}), ...over,
    };
    return { runs, deps, sched: createRoutineScheduler(deps), states: () => states };
  }

  it("runNow reports a stopped run; no sink is called; the record is still saved", async () => {
    const t = setup(routine([{ kind: "chat", instruction: "x" }]));
    const run = t.sched.runNow("r");
    await vi.waitFor(() => expect(t.runs.runRoutine).toHaveBeenCalled());
    t.sched.stopRuns("r");
    expect(await run).toEqual({ started: true, status: "failed", stopped: true });
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
    expect(t.states().r?.history).toHaveLength(1);
    expect(t.sched.isRunning("r")).toBe(false);
  });

  it("stopRuns on an idle sprout is a no-op, and a later run gets a fresh signal", async () => {
    const t = setup(routine([{ kind: "chat", instruction: "x" }]));
    t.sched.stopRuns("r");
    t.sched.stopRuns("nope");
    const run = t.sched.runNow("r");
    await vi.waitFor(() => expect(t.runs.runRoutine).toHaveBeenCalled());
    expect(t.runs.signals[0]?.aborted).toBe(false);
    t.runs.finishAll();
    expect(await run).toEqual({ started: true, status: "ok" });
    expect(t.deps.deliverDigest).toHaveBeenCalledOnce();
  });

  it("maxParallel workers: every worker's run is stopped and none claims again", async () => {
    const queue = ["1", "2", "3", "4"].map(todo);
    const claimTodo = vi.fn(async () => queue.shift());
    const t = setup(routine([{ kind: "chat", instruction: "x" }], { todoDriven: true, maxParallel: 2 }), {
      claimTodo, hasPendingTodos: async () => queue.length > 0,
    });
    const run = t.sched.runNow("r");
    await vi.waitFor(() => expect(t.runs.runRoutine).toHaveBeenCalledTimes(2));
    t.sched.stopRuns("r");
    expect(await run).toMatchObject({ started: true, stopped: true, status: "failed" });
    expect(claimTodo).toHaveBeenCalledTimes(2);
    expect(queue.map((x) => x.id)).toEqual(["3", "4"]);
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
  });

  it("a stopped watch run triggers no post-run poll; the next tick still runs it", async () => {
    const pollWatch = vi.fn(async () => []);
    const seen = { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] };
    const t = setup(routine([{ kind: "chat", instruction: "x" }], {
      cron: undefined, todoDriven: true, watch: { kind: "feed", url: "https://x", everyMinutes: 60 },
    }), { pollWatch, watchSeen: seen, hasPendingTodos: async () => true });
    const run = t.sched.runNow("r");
    await vi.waitFor(() => expect(t.runs.runRoutine).toHaveBeenCalled());
    t.sched.stopRuns("r");
    await run;
    await tick(); await tick();
    expect(pollWatch).not.toHaveBeenCalled();
    const next = t.sched.tick(); // the queue still has work: the next tick runs it again
    await vi.waitFor(() => expect(t.runs.runRoutine).toHaveBeenCalledTimes(2));
    t.runs.finishAll();
    await next;
  });
});

describe("routine host stop", () => {
  it("forwards the signal and reports a stopped finish line with what's still queued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-stop-host-"));
    try {
      const events: RoutineHostStatus[] = [];
      const host = createRoutineHost({
        dir, converse: async () => ({ content: "", toolCalls: [] }), getModel: () => "m",
        delegateStep: (req) => untilStopped(req.signal), commandStep: async () => ({ exitCode: 0, output: "" }),
        tools: [], loadSkills: async () => [], memories: async () => [], getRoutineDigestContext: () => false,
        onStatus: (e) => events.push(e),
      });
      for (const text of ["a", "b", "c"]) await addTodo(dbFile(dir), "r", text);
      const ctl = new AbortController();
      const run = host.runOneRoutine(routine([{ kind: "delegate", instruction: "x" }], { todoDriven: true }), undefined, ctl.signal);
      await vi.waitFor(async () => expect((await listTodos(dbFile(dir), "r")).some((x) => x.status === "running")).toBe(true));
      ctl.abort();
      expect((await run).stopped).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "finish", state: "failed", stopped: true, line: "Stopped · 2 still queued — disable in Sprouts to hold" });
      expect((await listTodos(dbFile(dir), "r")).map((x) => x.status).sort()).toEqual(["failed", "pending", "pending"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
