import { describe, expect, it, vi } from "vitest";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../src/routine-scheduler.js";
import { runRoutine, type RoutineRunnerDeps } from "../src/routine-runner.js";
import type { Routine, RoutineRunResult, RoutineState, TodoItem, TodoStatus } from "../src/index.js";

const d = (h: number, mi: number, day = 12) => new Date(2026, 6, day, h, mi);
const todo = (id: string, over: Partial<TodoItem> = {}): TodoItem =>
  ({ id, routine: "q", text: `task ${id}`, status: "pending", createdAt: "x", order: 0, ...over });

/** A run that stays open until release(id) — so tests can see what runs at once. */
function gatedRuns() {
  const open = new Map<string, () => void>();
  let live = 0;
  let peak = 0;
  const started: (string | undefined)[] = [];
  const runRoutine = vi.fn(async (_r: Routine, t?: TodoItem): Promise<RoutineRunResult> => {
    started.push(t?.id);
    live++; peak = Math.max(peak, live);
    await new Promise<void>((res) => open.set(t?.id ?? "all", res));
    live--;
    const record = { id: `run-${t?.id ?? "all"}`, startedAt: d(6, 31).toISOString(), finishedAt: d(6, 32).toISOString(), status: "ok" as const, digest: `did ${t?.id}`, steps: [] };
    return { record, digest: record.digest, results: [] };
  });
  return {
    runRoutine, started, peak: () => peak,
    release: (id: string) => { open.get(id)?.(); open.delete(id); },
    releaseAll: () => { for (const r of open.values()) r(); open.clear(); },
    openIds: () => [...open.keys()],
  };
}

function setup(r: Routine, queue: TodoItem[], over: Partial<RoutineSchedulerDeps> = {}) {
  let states: Record<string, RoutineState> = { [r.name]: { lastRun: d(6, 30, 11).toISOString(), history: [] } };
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => [r],
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine: vi.fn(async () => { throw new Error("unused"); }),
    deliverDigest: vi.fn(async () => {}),
    now: () => d(6, 31),
    hasPendingTodos: async () => queue.length > 0,
    claimTodo: async () => queue.shift(),
    ...over,
  };
  return { deps, sched: createRoutineScheduler(deps), states: () => states };
}

const cronQueue = (over: Partial<Routine> = {}): Routine => ({
  name: "q", enabled: true, cron: "30 6 * * *", todoDriven: true, maxParallel: 3,
  steps: [{ kind: "chat", instruction: "x" }], sinks: {}, ...over,
});

/** Drains the gated runs as they open until `done` resolves. */
async function drain(runs: ReturnType<typeof gatedRuns>, done: Promise<unknown>): Promise<void> {
  let finished = false;
  void done.then(() => { finished = true; });
  while (!finished) {
    await new Promise((res) => setTimeout(res, 1));
    runs.releaseAll();
  }
}

describe("maxParallel workers", () => {
  it.each(["cron fire", "watch tick"])("a %s runs 3 of 5 todos at once and refills until the queue is empty; each todo is its own run", async (kind) => {
    const runs = gatedRuns();
    const queue = ["1", "2", "3", "4", "5"].map((id) => todo(id));
    const r = kind === "cron fire" ? cronQueue() : { ...cronQueue(), cron: undefined, watch: { kind: "command" as const, command: "x", everyMinutes: 5 } };
    const t = setup(r, queue, {
      runRoutine: runs.runRoutine,
      pollWatch: vi.fn(async () => []),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    const tick = t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toHaveLength(3));
    expect(t.sched.isRunning("q")).toBe(true);
    await drain(runs, tick);
    expect(runs.started.sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(runs.peak()).toBe(3);
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(5);
    expect(t.states().q?.history).toHaveLength(5);
    t.sched.stop();
  });

  it("a running watch still ticks: a todo queued mid-run takes a free slot at once; the post-run poll fires", async () => {
    const runs = gatedRuns();
    const queue = [todo("1")];
    const watch: Routine = { ...cronQueue({ maxParallel: 2 }), cron: undefined, watch: { kind: "command", command: "x", everyMinutes: 5 } };
    const t = setup(watch, queue, {
      runRoutine: runs.runRoutine,
      loadStates: async () => ({ q: { history: [], lastPoll: d(6, 30).toISOString() } }), // poll not due
      pollWatch: vi.fn(async () => []),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    void t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toEqual(["1"]));
    queue.push(todo("2"));
    void t.sched.tick(); // a running watch still ticks; one slot is free
    await vi.waitFor(() => expect(runs.openIds()).toEqual(["1", "2"]));
    expect(t.deps.pollWatch).not.toHaveBeenCalled();
    runs.release("1");
    // The post-run poll fires right away, ignoring the interval.
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    runs.release("2");
    await vi.waitFor(() => expect(t.sched.isRunning("q")).toBe(false));
    t.sched.stop();
  });

  it("Run now fills free slots and refuses only at full", async () => {
    const runs = gatedRuns();
    const queue = ["1", "2", "3"].map((id) => todo(id));
    const t = setup(cronQueue({ maxParallel: 2 }), queue, { runRoutine: runs.runRoutine });
    const first = t.sched.runNow("q");
    await vi.waitFor(() => expect(runs.openIds()).toHaveLength(2));
    expect(await t.sched.runNow("q")).toEqual({ started: false, reason: "2/2 running" });
    await drain(runs, first);
    expect(await first).toEqual({ started: true });
    expect(runs.started).toHaveLength(3);
  });

  it("a lost claim does nothing: no run, record or digest", async () => {
    const t = setup(cronQueue(), [todo("1")], { runRoutine: vi.fn(async (): Promise<RoutineRunResult> => ({ record: { startedAt: "a", finishedAt: "b", status: "ok", digest: "", steps: [] }, digest: "", results: [] })) });
    await t.sched.tick();
    expect(t.deps.runRoutine).toHaveBeenCalledOnce(); // 3 workers, 1 todo: two claims lost
    expect(t.deps.deliverDigest).toHaveBeenCalledOnce();
    expect(t.states().q?.history).toHaveLength(1);
  });

  it("prunes step attempts only when the last sibling finishes", async () => {
    const runs = gatedRuns();
    const pruneAttempts = vi.fn();
    const t = setup(cronQueue({ maxParallel: 2 }), [todo("1"), todo("2")], { runRoutine: runs.runRoutine, pruneAttempts });
    const tick = t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toHaveLength(2));
    runs.release("1");
    await vi.waitFor(() => expect(t.states().q?.history).toHaveLength(1));
    expect(pruneAttempts).not.toHaveBeenCalled(); // run 2's attempt rows aren't in history yet
    runs.release("2");
    await tick;
    expect(pruneAttempts).toHaveBeenCalledOnce();
    expect(pruneAttempts.mock.calls[0]?.[1]).toEqual(["run-2", "run-1"]);
  });

  it("two siblings finishing at once: the last one still prunes", async () => {
    const runs = gatedRuns();
    const pruneAttempts = vi.fn();
    const t = setup(cronQueue({ maxParallel: 2 }), [todo("1"), todo("2")], { runRoutine: runs.runRoutine, pruneAttempts });
    const tick = t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toHaveLength(2));
    runs.releaseAll();
    await tick;
    expect(pruneAttempts).toHaveBeenCalledOnce();
    expect(pruneAttempts.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it("a Run now started while a tick is still deciding isn't run a second time by that tick", async () => {
    let releasePoll!: () => void;
    const watch: Routine = { name: "w", enabled: true, watch: { kind: "command", command: "x" }, steps: [], sinks: {} };
    const r = cronQueue({ maxParallel: undefined, todoDriven: false });
    const runRoutineFn = vi.fn(async (): Promise<RoutineRunResult> => ({ record: { startedAt: "a", finishedAt: "b", status: "ok", digest: "d", steps: [] }, digest: "d", results: [] }));
    const t = setup(r, [], {
      runRoutine: runRoutineFn,
      loadRoutines: async () => [r, watch],
      pollWatch: vi.fn(() => new Promise((res) => { releasePoll = () => res([]); })),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    const tick = t.sched.tick(); // q is due; the slow watch poll holds the tick
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    expect(await t.sched.runNow("q")).toEqual({ started: true });
    releasePoll();
    await tick;
    expect(runRoutineFn).toHaveBeenCalledOnce();
  });

  it("no post-run poll for a watch disabled mid-run", async () => {
    const runs = gatedRuns();
    let enabled = true;
    const watch = (): Routine => ({ ...cronQueue({ maxParallel: 2 }), cron: undefined, enabled, watch: { kind: "command", command: "x", everyMinutes: 5 } });
    const t = setup(watch(), [todo("1")], {
      runRoutine: runs.runRoutine,
      loadRoutines: async () => [watch()],
      loadStates: async () => ({ q: { history: [], lastPoll: d(6, 30).toISOString() } }),
      pollWatch: vi.fn(async () => []),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    const tick = t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toHaveLength(1));
    enabled = false;
    runs.release("1");
    await tick;
    await new Promise((res) => setTimeout(res, 5));
    expect(t.deps.pollWatch).not.toHaveBeenCalled();
  });

  it("a sibling that starts a run while a finished run's record is saving isn't pruned out from under", async () => {
    const runs = gatedRuns();
    const pruneAttempts = vi.fn();
    let states: Record<string, RoutineState> = { q: { lastRun: d(6, 30, 11).toISOString(), history: [] } };
    let hold = false;
    const saves: (() => void)[] = [];
    const t = setup(cronQueue({ maxParallel: 2 }), ["1", "2", "3"].map((id) => todo(id)), {
      runRoutine: runs.runRoutine, pruneAttempts,
      loadStates: async () => states,
      saveStates: async (next) => { if (hold) await new Promise<void>((res) => saves.push(res)); states = next; },
    });
    const tick = t.sched.tick();
    await vi.waitFor(() => expect(runs.openIds()).toEqual(["1", "2"]));
    hold = true;
    runs.release("2"); // B finishes first (A live): its save waits
    runs.release("1"); // A finishes with nothing in flight: its save queues behind B's
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    hold = false;
    saves.shift()!(); // B's record lands; B claims todo 3 and starts it
    await vi.waitFor(() => expect(runs.openIds()).toEqual(["3"]));
    expect(pruneAttempts).not.toHaveBeenCalled(); // A saw run 3 live after its save
    runs.release("3");
    await tick;
    expect(pruneAttempts).toHaveBeenCalledOnce(); // the last finisher
  });

  it("an older tick never runs a sprout on a newer tick's flag after Run now", async () => {
    let releasePoll!: () => void;
    let releaseStates: (() => void) | undefined;
    let blockStates = false;
    const watch: Routine = { name: "w", enabled: true, watch: { kind: "command", command: "x" }, steps: [], sinks: {} };
    const r = cronQueue({ maxParallel: undefined, todoDriven: false });
    let states: Record<string, RoutineState> = { q: { lastRun: d(6, 30, 11).toISOString(), history: [] } };
    const runRoutineFn = vi.fn(async (): Promise<RoutineRunResult> => ({ record: { startedAt: d(6, 31).toISOString(), finishedAt: "b", status: "ok", digest: "d", steps: [] }, digest: "d", results: [] }));
    const t = setup(r, [], {
      runRoutine: runRoutineFn,
      loadRoutines: async () => [r, watch],
      loadStates: async () => {
        if (blockStates) { blockStates = false; await new Promise<void>((res) => { releaseStates = res; }); }
        return states;
      },
      saveStates: async (next) => { states = next; },
      pollWatch: vi.fn(() => new Promise((res) => { releasePoll = () => res([]); })),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    const first = t.sched.tick(); // q due; the slow watch poll holds this tick
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    await t.sched.runNow("q");
    blockStates = true;
    const second = t.sched.tick(); // re-flags q, then waits in its states load
    await vi.waitFor(() => expect(releaseStates).toBeDefined());
    releasePoll();
    await first;
    releaseStates!();
    await second;
    expect(runRoutineFn).toHaveBeenCalledOnce();
  });

  it("maxParallel 1 (or absent) is today's single drain run: one runRoutine call, no todo, one digest", async () => {
    const runRoutineFn = vi.fn(async (): Promise<RoutineRunResult> => ({ record: { startedAt: "a", finishedAt: "b", status: "ok", digest: "d", steps: [] }, digest: "d", results: [] }));
    const claimTodo = vi.fn(async () => undefined);
    const t = setup(cronQueue({ maxParallel: undefined }), [todo("1"), todo("2")], { runRoutine: runRoutineFn, claimTodo });
    await t.sched.tick();
    expect(runRoutineFn).toHaveBeenCalledOnce();
    expect(runRoutineFn.mock.calls[0]).toHaveLength(1); // the routine only — the run claims its own todos
    expect(claimTodo).not.toHaveBeenCalled();
    expect(t.deps.deliverDigest).toHaveBeenCalledOnce();
  });

  it("a member-refused todo fails without stalling the refill (real runner)", async () => {
    const statuses: [string, TodoStatus][] = [];
    const queue = [todo("m", { createdBy: "member-1" }), todo("1"), todo("2")];
    const r = cronQueue({ maxParallel: 2, steps: [{ kind: "delegate", instruction: "build" }] });
    const delegate = vi.fn(async () => "built");
    const runnerDeps: RoutineRunnerDeps = {
      chat: async () => ({ content: "digest", toolCalls: [] }), model: "m", delegate, tools: [], findSkill: () => undefined,
      todos: { claim: async () => { throw new Error("a worker's run never claims"); }, setStatus: async (id, s) => { statuses.push([id, s]); } },
    };
    const t = setup(r, queue, { runRoutine: (rt, tt) => runRoutine(rt, runnerDeps, tt) });
    await t.sched.tick();
    expect(statuses).toEqual(expect.arrayContaining([["m", "failed"], ["1", "done"], ["2", "done"]]));
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(t.states().q?.history.map((h) => h.status).sort()).toEqual(["failed", "ok", "ok"]);
  });
});
