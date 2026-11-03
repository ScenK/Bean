import { describe, expect, it, vi } from "vitest";
import { sproutTriggerAction } from "../src/sprout-trigger.js";
import { createRoutineScheduler, triggerOutcome, type RoutineSchedulerDeps } from "../src/routine-scheduler.js";
import type { Routine, RoutineRunResult, RoutineState, RunStatus, TodoItem } from "../src/index.js";

const steps = [{ kind: "chat" as const, instruction: "x" }];
const watch = { kind: "command" as const, command: "x", everyMinutes: 5 };
const schedule: Routine = { name: "s", enabled: true, cron: "30 6 * * *", steps, sinks: {} };
const todoSprout: Routine = { ...schedule, name: "q", todoDriven: true };
const queueWatch: Routine = { name: "w", enabled: true, watch, todoDriven: true, steps, sinks: {} };
const notifyWatch: Routine = { name: "n", enabled: true, watch, steps: [], sinks: {} };

describe("sproutTriggerAction", () => {
  it.each<[string, Routine, number, "run" | "check"]>([
    ["schedule", schedule, 0, "run"],
    ["todo-driven schedule, pending", todoSprout, 2, "run"],
    ["todo-driven schedule, empty", todoSprout, 0, "run"],
    ["watch with steps, pending", queueWatch, 1, "run"],
    ["watch with steps, empty", queueWatch, 0, "check"],
    ["notify-only watch", notifyWatch, 0, "check"],
    ["notify-only watch, stray pending", notifyWatch, 3, "check"],
  ])("%s → %s", (_label, r, pending, want) => {
    expect(sproutTriggerAction(r, pending)).toBe(want);
  });
});

const todo = (id: string): TodoItem => ({ id, routine: "q", text: id, status: "pending", createdAt: "x", order: 0 });
const result = (status: RunStatus): RoutineRunResult => {
  const record = { startedAt: "a", finishedAt: "b", status, digest: status, steps: [] };
  return { record, digest: status, results: [] };
};

function setup(routines: Routine[], over: Partial<RoutineSchedulerDeps> = {}) {
  let states: Record<string, RoutineState> = {};
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => routines,
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine: vi.fn(async () => result("ok")),
    deliverDigest: vi.fn(async () => {}),
    ...over,
  };
  return createRoutineScheduler(deps);
}

describe("scheduler trigger", () => {
  it("answers started while the run is still going; done resolves with the outcome", async () => {
    let finish!: (r: RoutineRunResult) => void;
    const runRoutine = vi.fn(() => new Promise<RoutineRunResult>((res) => { finish = res; }));
    const sched = setup([schedule], { runRoutine });
    const t = await sched.trigger("s", "run");
    expect(t.status).toBe("started");
    if (t.status !== "started") return;
    await vi.waitFor(() => expect(runRoutine).toHaveBeenCalled());
    let settled = false;
    void t.done.then(() => { settled = true; });
    await new Promise((res) => setTimeout(res, 5));
    expect(settled).toBe(false);
    expect(sched.isRunning("s")).toBe(true);
    finish(result("needs-attention"));
    expect(await t.done).toEqual({ status: "needs-attention", runs: 1, ok: 0, needsAttention: 1, failed: 0 });
  });

  it("aggregates parallel workers, counting a worker that claims nothing as no run", async () => {
    const queue = [todo("1"), todo("2")];
    const status: Record<string, RunStatus> = { "1": "ok", "2": "needs-attention" };
    const sched = setup([{ ...todoSprout, maxParallel: 3 }], {
      hasPendingTodos: async () => queue.length > 0,
      claimTodo: async () => queue.shift(),
      runRoutine: vi.fn(async (_r: Routine, t?: TodoItem) => result(status[t?.id ?? ""] ?? "ok")),
    });
    const t = await sched.trigger("q", "run");
    if (t.status !== "started") throw new Error(`not started: ${JSON.stringify(t)}`);
    expect(await t.done).toEqual({ status: "needs-attention", runs: 2, ok: 1, needsAttention: 1, failed: 0 });
  });

  it("failed beats needs-attention, and a throwing run counts as failed", async () => {
    const queue = [todo("1"), todo("2"), todo("3")];
    const sched = setup([{ ...todoSprout, maxParallel: 2 }], {
      hasPendingTodos: async () => queue.length > 0,
      claimTodo: async () => queue.shift(),
      runRoutine: vi.fn(async (_r: Routine, t?: TodoItem) => {
        if (t?.id === "2") throw new Error("boom");
        return result(t?.id === "3" ? "needs-attention" : "ok");
      }),
    });
    const t = await sched.trigger("q", "run");
    if (t.status !== "started") throw new Error("not started");
    expect(await t.done).toEqual({ status: "failed", runs: 3, ok: 1, needsAttention: 1, failed: 1 });
  });

  it("refuses with runNow's reasons, plus an empty queue", async () => {
    let finish!: () => void;
    const held = vi.fn(() => new Promise<RoutineRunResult>((res) => { finish = () => res(result("ok")); }));
    const queue = [todo("1"), todo("2")];
    const sched = setup([schedule, notifyWatch, { ...todoSprout, maxParallel: 2 }], {
      runRoutine: held,
      hasPendingTodos: async () => queue.length > 0,
      claimTodo: async () => queue[0],
    });
    expect(await sched.trigger("nope", "run")).toEqual({ status: "refused", reason: 'no sprout named "nope"' });
    expect(await sched.trigger("nope", "check")).toEqual({ status: "refused", reason: 'no sprout named "nope"' });
    expect(await sched.trigger("n", "run")).toEqual({ status: "refused", reason: "a notify-only watch has no steps to run — use Check now" });
    expect((await sched.trigger("s", "run")).status).toBe("started");
    expect(await sched.trigger("s", "run")).toEqual({ status: "refused", reason: "already running" });
    expect(await sched.runNow("s")).toEqual({ started: false, reason: "already running" });
    expect((await sched.trigger("q", "run")).status).toBe("started");
    expect(await sched.trigger("q", "run")).toEqual({ status: "refused", reason: "2/2 running" });
    queue.length = 0;
    expect(await sched.trigger("q", "run")).toEqual({ status: "refused", reason: "queue's empty now" });
    finish();
    sched.stop();
  });

  it("check polls the watch and returns its result", async () => {
    const sched = setup([notifyWatch, schedule], {
      pollWatch: vi.fn(async () => []),
      watchSeen: { isSeeded: () => true, seed: () => {}, unseen: () => [], markNew: () => [] },
    });
    expect(await sched.trigger("n", "check")).toEqual({ status: "checked", result: { newItems: 0 } });
    expect(await sched.trigger("s", "check")).toEqual({ status: "checked", result: { newItems: 0, error: 'no watch sprout named "s"' } });
  });

  it("an empty fold is ok with no runs", () => {
    expect(triggerOutcome([])).toEqual({ status: "ok", runs: 0, ok: 0, needsAttention: 0, failed: 0 });
  });
});
