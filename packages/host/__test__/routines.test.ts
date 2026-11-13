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
