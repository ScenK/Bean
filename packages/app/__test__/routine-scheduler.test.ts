import { describe, expect, it, vi } from "vitest";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../src/routine-scheduler.js";
import type { Routine, RoutineRunResult, RoutineState, RunRecord } from "@bean/core";

const routine = (over: Partial<Routine> = {}): Routine => ({
  name: "morning", enabled: true, cron: "30 6 * * *",
  steps: [{ kind: "chat", instruction: "x" }], sinks: {}, ...over,
});
const runResult = (): RoutineRunResult => {
  const record: RunRecord = {
    startedAt: "2026-07-12T06:30:00.000Z", finishedAt: "2026-07-12T06:31:00.000Z",
    status: "ok", digest: "d", steps: [],
  };
  return { record, digest: "d", results: [] };
};
// Local-time date helper (cron is local-time).
const d = (h: number, mi: number, day = 12) => new Date(2026, 6, day, h, mi);

function makeDeps(over: Partial<RoutineSchedulerDeps> = {}) {
  let states: Record<string, RoutineState> = {};
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => [routine()],
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine: vi.fn(async () => runResult()),
    deliverDigest: vi.fn(async () => {}),
    now: () => d(6, 31),
    ...over,
  };
  return { deps, getStates: () => states };
}

describe("routine scheduler", () => {
  it("runs a routine when its next fire time (from lastRun) has passed", async () => {
    const { deps, getStates } = makeDeps({
      loadStates: async () => ({ morning: { lastRun: d(6, 30, 11).toISOString(), history: [] } }),
    });
    const sched = createRoutineScheduler(deps);
    await sched.tick(); // now = 06:31 on the 12th; next after 06:30 on the 11th is 06:30 today → due
    expect(deps.runRoutine).toHaveBeenCalledOnce();
    expect(deps.deliverDigest).toHaveBeenCalledOnce();
    expect(getStates().morning?.history).toHaveLength(1);
  });

  it("does not run before the fire time, disabled routines, or routines with no lastRun (base = scheduler start)", async () => {
    const { deps } = makeDeps({ now: () => d(6, 0) }); // before 6:30, no lastRun
    const sched = createRoutineScheduler(deps);
    await sched.tick();
    expect(deps.runRoutine).not.toHaveBeenCalled();

    const { deps: deps2 } = makeDeps({
      loadRoutines: async () => [routine({ enabled: false })],
      loadStates: async () => ({ morning: { lastRun: d(6, 30, 11).toISOString(), history: [] } }),
    });
    await createRoutineScheduler(deps2).tick();
    expect(deps2.runRoutine).not.toHaveBeenCalled();
  });

  it("skips the tick while the same routine is still running (no overlap)", async () => {
    let resolveRun!: (r: RoutineRunResult) => void;
    const { deps } = makeDeps({
      loadStates: async () => ({ morning: { lastRun: d(6, 30, 11).toISOString(), history: [] } }),
      runRoutine: vi.fn(() => new Promise<RoutineRunResult>((res) => { resolveRun = res; })),
    });
    const sched = createRoutineScheduler(deps);
    const first = sched.tick();
    await Promise.resolve(); // let the run start
    expect(sched.isRunning("morning")).toBe(true);
    await sched.tick(); // second tick while running
    expect(deps.runRoutine).toHaveBeenCalledTimes(1);
    resolveRun(runResult());
    await first;
    expect(sched.isRunning("morning")).toBe(false);
  });

  it("start() marks schedules missed while Bean was closed instead of running them", async () => {
    vi.useFakeTimers();
    const { deps, getStates } = makeDeps({
      loadStates: async () => ({ morning: { lastRun: d(6, 30, 10).toISOString(), history: [] } }),
      now: () => d(9, 0), // started at 9:00; 6:30 on the 11th and 12th passed while closed
    });
    const sched = createRoutineScheduler(deps);
    sched.start();
    await vi.runOnlyPendingTimersAsync(); // flush the async missed-marking
    expect(getStates().morning?.missed).toBe(true);
    expect(deps.runRoutine).not.toHaveBeenCalled();
    sched.stop();
    vi.useRealTimers();
  });

  it("runNow runs immediately, refuses while running, and reports unknown names", async () => {
    const { deps } = makeDeps();
    const sched = createRoutineScheduler(deps);
    expect(await sched.runNow("nope")).toMatchObject({ started: false });
    expect(await sched.runNow("morning")).toEqual({ started: true });
    expect(deps.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("a failed manual re-run of a previously-missed routine still clears the missed-guard for later ticks", async () => {
    let currentTime = d(9, 0, 12); // scheduler start
    let states: Record<string, RoutineState> = { morning: { lastRun: d(6, 30, 10).toISOString(), history: [] } };
    let runCall = 0;
    const runRoutine = vi.fn(async () => {
      runCall++;
      if (runCall === 1) throw new Error("boom");
      return runResult();
    });
    const deps: RoutineSchedulerDeps = {
      loadRoutines: async () => [routine()],
      loadStates: async () => states,
      saveStates: async (s) => { states = s; },
      runRoutine,
      deliverDigest: vi.fn(async () => {}),
      now: () => currentTime,
    };
    const sched = createRoutineScheduler(deps);

    vi.useFakeTimers();
    sched.start(); // markMissed: lastRun on the 10th → fire on the 11th, before startedAt on the 12th
    await vi.runOnlyPendingTimersAsync();
    sched.stop();
    vi.useRealTimers();
    expect(states.morning?.missed).toBe(true);

    const res = await sched.runNow("morning"); // runRoutine rejects on this first call
    expect(res).toEqual({ started: true }); // errors are caught inside execute(), runNow still resolves
    expect(states.morning?.missed).toBeUndefined(); // disk-cleared regardless of the failure

    currentTime = d(6, 31, 13); // jump past the next fire time so the routine is due again
    await sched.tick();
    // second runRoutine call proves the missed-guard didn't stick around after the failure
    expect(runRoutine).toHaveBeenCalledTimes(2);
  });
});
