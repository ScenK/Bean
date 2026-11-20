import { expect, it, test, vi } from "vitest";
import { buildRoutineHandlers } from "../src/index.js";
import type { Routine } from "@bean/core";

const routine: Routine = {
  name: "r", enabled: true, cron: "0 6 * * *",
  steps: [{ kind: "chat", instruction: "x" }], sinks: {},
};

test("routine handlers merge in-memory running state into the state view", async () => {
  const h = buildRoutineHandlers({
    loadRoutines: async () => [routine],
    saveRoutine: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({ r: { lastRun: "2026-07-12T06:30:00.000Z", history: [] } }),
    isRunning: (name) => name === "r",
    runningCount: () => 1,
    runNow: async () => ({ started: true }),
  });
  const state = await h.state();
  expect(state.r).toMatchObject({ lastRun: "2026-07-12T06:30:00.000Z", running: true, runningCount: 1 });
  expect(state.r?.queue).toBeUndefined(); // not todo-driven
});

test("routine state carries the core's ended/archived view; a live sprout has none (#983)", async () => {
  const h = buildRoutineHandlers({
    loadRoutines: async () => [routine, { ...routine, name: "old", enabled: false, until: "2020-01-02" }],
    saveRoutine: vi.fn(async () => {}), deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => false, runningCount: () => 0,
    runNow: async () => ({ started: true }),
  });
  const state = await h.state();
  expect(state.old?.ended).toEqual({ archived: true, text: "Nothing by Jan 2" });
  expect(state.r?.ended).toBeUndefined();
});

test("routine state fills the queue for every todo-driven sprout, cron included", async () => {
  const queueCounts = vi.fn(async () => ({ pending: 2, running: 3 }));
  const h = buildRoutineHandlers({
    loadRoutines: async () => [{ ...routine, todoDriven: true, maxParallel: 3 }],
    saveRoutine: vi.fn(async () => {}), deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => true, runningCount: () => 3, queueCounts,
    runNow: async () => ({ started: true }),
  });
  const state = await h.state();
  expect(state.r).toMatchObject({ running: true, runningCount: 3, queue: { pending: 2, running: 3 } });
  expect(queueCounts).toHaveBeenCalledWith("r");
});

test("routine handlers save delegates (validation is core saveRoutine's job); delete and runNow pass through", async () => {
  const saveRoutine = vi.fn(async () => {});
  const runNow = vi.fn(async () => ({ started: true }) as const);
  const h = buildRoutineHandlers({
    loadRoutines: async () => [], saveRoutine, deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => false, runningCount: () => 0, runNow,
  });
  await h.save(routine);
  expect(saveRoutine).toHaveBeenCalledWith(routine);
  // A rejection from the real (core) saveRoutine — e.g. an invalid-cron error — propagates
  // unchanged, so the renderer sees the specific reason rather than a generic message.
  saveRoutine.mockRejectedValueOnce(new Error(`cron schedule "bad" is not a valid 5-field cron expression`));
  await expect(h.save({ ...routine, cron: "bad" })).rejects.toThrow("is not a valid 5-field cron expression");
  await h.runNow("r");
  expect(runNow).toHaveBeenCalledWith("r");
});

test("routine stop reaches stopRuns only for a running sprout's name", () => {
  const stopRuns = vi.fn();
  const h = buildRoutineHandlers({
    loadRoutines: async () => [], saveRoutine: vi.fn(async () => {}), deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: (name) => name === "r", runningCount: () => 1,
    runNow: vi.fn(async () => ({ started: true })), stopRuns,
  });
  for (const bad of [undefined, 42, { name: "r" }, ["r"], "idle"]) h.stop(bad);
  expect(stopRuns).not.toHaveBeenCalled();
  h.stop("r");
  expect(stopRuns).toHaveBeenCalledExactlyOnceWith("r");
});

it("buildRoutineHandlers.remove cascades to onRoutineDeleted", async () => {
  const deleted: string[] = [];
  const h = buildRoutineHandlers({
    loadRoutines: async () => [],
    saveRoutine: async () => {},
    deleteRoutine: async () => {},
    loadStates: async () => ({}),
    isRunning: () => false,
    runningCount: () => 0,
    runNow: async () => ({ started: true }),
    onRoutineDeleted: async (name) => { deleted.push(name); },
  });
  await h.remove("nightly");
  expect(deleted).toEqual(["nightly"]);
});

test("save refuses turning on a sprout whose end has passed; an already-on one still saves (#980)", async () => {
  const saveRoutine = vi.fn(async () => {});
  const rebase = vi.fn(async () => {});
  const ended: Routine = { ...routine, enabled: false, until: "2020-01-01" };
  const h = (prior: Routine) => buildRoutineHandlers({
    loadRoutines: async () => [prior], saveRoutine, deleteRoutine: vi.fn(async () => {}), rebase,
    loadStates: async () => ({}), isRunning: () => false, runningCount: () => 0, runNow: async () => ({ started: true }),
  });
  await expect(h(ended).save({ ...ended, enabled: true })).rejects.toThrow(/later end date/);
  expect(saveRoutine).not.toHaveBeenCalled();
  await h(ended).save({ ...ended, enabled: true, until: "2999-01-01" });
  expect(rebase).toHaveBeenCalledWith(ended.name); // restored: its schedule restarts from now
  await h({ ...ended, enabled: true }).save({ ...ended, enabled: true, description: "edited" });
  expect(saveRoutine).toHaveBeenCalledTimes(2);
  expect(rebase).toHaveBeenCalledTimes(1);
});

test("turning an ended watch back on with a later until goes through enableWatch (re-seeded from now), outside the lane", async () => {
  const saveRoutine = vi.fn(async () => {});
  let inLane = false;
  const enableWatch = vi.fn(async () => { expect(inLane).toBe(false); return { count: 0 }; });
  const withSprout = async <T,>(_n: string, fn: () => Promise<T>): Promise<T> => { inLane = true; try { return await fn(); } finally { inLane = false; } };
  const ended: Routine = { name: "w", enabled: false, until: "2020-01-01", watch: { kind: "feed", url: "https://f" }, todoDriven: true, steps: [{ kind: "chat", instruction: "x" }], sinks: {} };
  const h = buildRoutineHandlers({
    loadRoutines: async () => [ended], saveRoutine, deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => false, runningCount: () => 0, runNow: async () => ({ started: true }),
    watch: { enableWatch } as never, withSprout,
  });
  await h.save({ ...ended, enabled: true, until: "2999-01-01" });
  // Still ended until enableWatch's check succeeds and commits the new end with `enabled`.
  expect(saveRoutine).toHaveBeenCalledWith({ ...ended, enabled: false });
  expect(enableWatch).toHaveBeenCalledWith("w", false, "2999-01-01");
  const { until: _, ...open } = ended;
  await h.save({ ...open, enabled: true });
  expect(enableWatch).toHaveBeenLastCalledWith("w", false, null); // the end date cleared
});
