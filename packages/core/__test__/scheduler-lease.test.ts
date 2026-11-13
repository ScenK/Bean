import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../src/db.js";
import { claimSchedulerLease, holdSchedulerLease } from "../src/scheduler-lease.js";
import { createRoutineScheduler } from "../src/routine-scheduler.js";
import type { Routine, RoutineRunResult, RoutineState } from "../src/index.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-lease-"));
  file = join(dir, "bean.db");
});
afterEach(async () => {
  vi.useRealTimers();
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const TTL = 90_000;

describe("scheduler lease", () => {
  it("one holder at a time; renewals by the holder succeed; expired leases are taken over", () => {
    expect(claimSchedulerLease(file, "a", "A", 0, TTL)).toBeUndefined();
    expect(claimSchedulerLease(file, "b", "B", 1_000, TTL)).toMatchObject({ holder: "a", label: "A" });
    expect(claimSchedulerLease(file, "a", "A", 30_000, TTL)).toBeUndefined(); // renew → expires 120s
    expect(claimSchedulerLease(file, "b", "B", 100_000, TTL)).toMatchObject({ holder: "a" });
    expect(claimSchedulerLease(file, "b", "B", 120_001, TTL)).toBeUndefined(); // a crashed
    expect(claimSchedulerLease(file, "a", "A", 120_002, TTL)).toMatchObject({ holder: "b" });
  });

  it("two schedulers on one data directory: exactly one fires a due routine", async () => {
    const routine: Routine = { name: "morning", enabled: true, cron: "30 6 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {} };
    let states: Record<string, RoutineState> = { morning: { lastRun: new Date(2026, 6, 11, 6, 30).toISOString(), history: [] } };
    const runRoutine = vi.fn(async (): Promise<RoutineRunResult> => ({
      record: { startedAt: "", finishedAt: "", status: "ok", digest: "d", steps: [] }, digest: "d", results: [],
    }));
    const startOne = (label: string): { stop: () => void; ticked: Promise<void>[] } => {
      const sched = createRoutineScheduler({
        loadRoutines: async () => [routine], loadStates: async () => states, saveStates: async (s) => { states = s; },
        runRoutine, deliverDigest: async () => {}, now: () => new Date(2026, 6, 12, 6, 31),
      });
      const ticked: Promise<void>[] = [];
      const lease = holdSchedulerLease({
        file, label, heartbeatMs: 60_000_000,
        onAcquired: () => { ticked.push(sched.tick()); }, onBlocked: () => {}, onLost: () => {},
      });
      return { stop: lease.stop, ticked };
    };
    const a = startOne("A");
    const b = startOne("B");
    await Promise.all([...a.ticked, ...b.ticked]);
    expect(a.ticked.length + b.ticked.length).toBe(1);
    expect(runRoutine).toHaveBeenCalledOnce();
    a.stop();
    b.stop();
  });

  it("canSchedule false: tick() fires nothing (a standby host's manual-run follow-up tick)", async () => {
    let held = false;
    const runRoutine = vi.fn(async (): Promise<RoutineRunResult> => ({
      record: { startedAt: "", finishedAt: "", status: "ok", digest: "d", steps: [] }, digest: "d", results: [],
    }));
    const sched = createRoutineScheduler({
      loadRoutines: async () => [{ name: "morning", enabled: true, cron: "30 6 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {} }],
      loadStates: async () => ({ morning: { lastRun: new Date(2026, 6, 11, 6, 30).toISOString(), history: [] } }),
      saveStates: async () => {}, runRoutine, deliverDigest: async () => {}, now: () => new Date(2026, 6, 12, 6, 31),
      canSchedule: () => held,
    });
    await sched.tick();
    expect(runRoutine).not.toHaveBeenCalled();
    held = true;
    await sched.tick();
    expect(runRoutine).toHaveBeenCalledOnce();
  });

  it("a refused process stands by and takes over after a crashed holder's lease expires; the stalled holder learns it lost", () => {
    vi.useFakeTimers({ now: 0 });
    const a = { acquired: vi.fn(), blocked: vi.fn(), lost: vi.fn() };
    const b = { acquired: vi.fn(), blocked: vi.fn(), lost: vi.fn() };
    // A stalls (sleep / hung event loop): its first heartbeat comes at 200s, past its 90s TTL.
    const leaseA = holdSchedulerLease({ file, label: "A", ttlMs: TTL, heartbeatMs: 200_000, onAcquired: a.acquired, onBlocked: a.blocked, onLost: a.lost });
    expect(a.acquired).toHaveBeenCalledOnce();
    const leaseB = holdSchedulerLease({ file, label: "B", ttlMs: TTL, heartbeatMs: 30_000, onAcquired: b.acquired, onBlocked: b.blocked, onLost: b.lost });
    expect(b.blocked).toHaveBeenCalledOnce();
    expect(b.blocked.mock.calls[0]?.[0].label).toMatch(/^A \(pid \d+ on /);
    vi.advanceTimersByTime(90_000); // beats at 30/60/90s: not expired yet (expires == now)
    expect(b.acquired).not.toHaveBeenCalled();
    expect(b.blocked).toHaveBeenCalledOnce(); // notice once, not per beat
    vi.advanceTimersByTime(30_000); // 120s: expired → B takes over
    expect(b.acquired).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(80_000); // 200s: A heartbeats and finds B holding it
    expect(a.lost).toHaveBeenCalledOnce();
    expect(a.lost.mock.calls[0]?.[0].label).toMatch(/^B /);
    expect(b.lost).not.toHaveBeenCalled();
    const t = Date.now();
    leaseA.stop();
    expect(claimSchedulerLease(file, "x", "X", t, TTL)?.label).toMatch(/^B /); // A's stop didn't drop B's lease
    leaseB.stop();
    expect(claimSchedulerLease(file, "x", "X", t, TTL)).toBeUndefined(); // clean stop releases
  });
});
