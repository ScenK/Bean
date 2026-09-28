import { describe, expect, it, vi } from "vitest";
import { createRoutineScheduler, ALARM_AFTER, type RoutineSchedulerDeps, type WatchSeenDeps } from "../src/routine-scheduler.js";
import type { Routine, RoutineRunResult, RoutineState, WatchItem } from "@bean/core";

const notify = (over: Partial<Routine> = {}): Routine => ({
  name: "yt", enabled: true, watch: { kind: "feed", url: "https://f", everyMinutes: 15 }, steps: [], sinks: {}, ...over,
});
const queue = (over: Partial<Routine> = {}): Routine => ({
  name: "prs", enabled: true, todoDriven: true, watch: { kind: "command", command: "gh …", everyMinutes: 5 },
  steps: [{ kind: "delegate", skill: "code-review", instruction: "review" }], sinks: {}, ...over,
});

function fakeSeen(): WatchSeenDeps {
  const sources = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  return {
    isSeeded: (r, source) => {
      if (sources.get(r) === source) return true;
      sources.delete(r); seen.delete(r);
      return false;
    },
    seed: (r, source, ids) => { sources.set(r, source); seen.set(r, new Set(ids)); },
    unseen: (r, ids) => ids.filter((id) => !(seen.get(r) ?? new Set<string>()).has(id)),
    markNew: (r, ids) => {
      const set = seen.get(r) ?? new Set<string>();
      const fresh = ids.filter((id) => !set.has(id));
      for (const id of ids) set.add(id);
      seen.set(r, set);
      return fresh;
    },
  };
}

function setup(routines: Routine[], over: Partial<RoutineSchedulerDeps> = {}) {
  let states: Record<string, RoutineState> = {};
  let items: WatchItem[] = [];
  let pollError: Error | undefined;
  let clock = new Date(2026, 8, 28, 9, 0);
  const pending: string[] = [];
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => routines,
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine: vi.fn(async (): Promise<RoutineRunResult> => {
      pending.length = 0;
      const record = { startedAt: clock.toISOString(), finishedAt: clock.toISOString(), status: "ok" as const, digest: "ran", steps: [] };
      return { record, digest: "ran", results: [] };
    }),
    deliverDigest: vi.fn(async () => {}),
    now: () => clock,
    hasPendingTodos: async () => pending.length > 0,
    pollWatch: vi.fn(async () => { if (pollError) throw pollError; return items; }),
    watchSeen: fakeSeen(),
    addTodo: vi.fn(async (_r: string, text: string) => { pending.push(text); }),
    saveRoutine: vi.fn(async () => {}),
    alarm: vi.fn(),
    ...over,
  };
  return {
    deps,
    sched: createRoutineScheduler(deps),
    states: () => states,
    setItems: (next: WatchItem[]) => { items = next; },
    fail: (err?: Error) => { pollError = err; },
    advance: (mins: number) => { clock = new Date(clock.getTime() + mins * 60_000); },
    pending,
  };
}

describe("watch triggers", () => {
  it("seeds on the first poll (fires nothing), then notifies on new items with one run record", async () => {
    const t = setup([notify()]);
    t.setItems([{ id: "v1", text: "Old video", link: "https://v1" }]);
    await t.sched.tick();
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
    expect(t.states().yt?.lastPoll).toBeDefined();

    t.setItems([{ id: "v2", text: "New video", link: "https://v2" }, { id: "v1", text: "Old video" }]);
    t.advance(15);
    await t.sched.tick();
    expect(t.deps.runRoutine).not.toHaveBeenCalled(); // no LLM, no runRoutine
    expect(t.deps.deliverDigest).toHaveBeenCalledOnce();
    const [, result] = vi.mocked(t.deps.deliverDigest).mock.calls[0]!;
    expect(result.digest).toBe("New: New video\nhttps://v2");
    expect(t.states().yt?.history).toHaveLength(1);
    expect(t.states().yt?.history[0]?.steps).toEqual([]);
  });

  it("respects the interval between polls", async () => {
    const t = setup([notify()]);
    await t.sched.tick();
    t.advance(5);
    await t.sched.tick();
    expect(t.deps.pollWatch).toHaveBeenCalledOnce();
    t.advance(10);
    await t.sched.tick();
    expect(t.deps.pollWatch).toHaveBeenCalledTimes(2);
  });

  it("todo-driven: new items are queued, and the queue — not the poller — makes the routine due", async () => {
    const t = setup([queue()]);
    t.setItems([{ id: "pr1", text: "PR 1" }]);
    await t.sched.tick(); // seed
    expect(t.deps.addTodo).not.toHaveBeenCalled();
    expect(t.deps.runRoutine).not.toHaveBeenCalled();

    t.setItems([{ id: "pr1", text: "PR 1" }, { id: "pr2", text: "PR 2" }]);
    t.advance(5);
    await t.sched.tick();
    expect(t.deps.addTodo).toHaveBeenCalledWith("prs", "PR 2");
    expect(t.deps.runRoutine).toHaveBeenCalledOnce(); // drained in the same tick, after the polls
  });

  it("a deferred run (project busy) records and delivers nothing", async () => {
    const t = setup([queue()], {
      runRoutine: vi.fn(async (): Promise<RoutineRunResult> => ({
        record: { startedAt: "", finishedAt: "", status: "ok", digest: "", steps: [] }, digest: "", results: [], deferred: true,
      })),
    });
    t.pending.push("PR 9");
    await t.sched.tick();
    expect(t.deps.runRoutine).toHaveBeenCalledOnce();
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
    expect(t.states().prs?.history ?? []).toHaveLength(0);
  });

  it("stores pollError from the first failure, alarms once after 3 in a row, resets on success", async () => {
    const t = setup([notify()]);
    t.fail(new Error("feed returned HTTP 302 → consent.youtube.com"));
    for (let i = 0; i < ALARM_AFTER + 1; i++) { await t.sched.tick(); t.advance(15); }
    expect(t.states().yt?.pollError).toMatch(/consent/);
    expect(t.sched.pollFailures("yt")).toBe(ALARM_AFTER + 1);
    expect(t.deps.alarm).toHaveBeenCalledOnce();
    t.fail(undefined);
    await t.sched.tick();
    expect(t.states().yt?.pollError).toBeUndefined();
    expect(t.sched.pollFailures("yt")).toBe(0);
  });

  it("re-seeds when the command changes", async () => {
    const routines = [queue()];
    const t = setup(routines);
    t.setItems([{ id: "a", text: "A" }]);
    await t.sched.tick();
    routines[0] = queue({ watch: { kind: "command", command: "different", everyMinutes: 5 } });
    t.setItems([{ id: "a", text: "A" }, { id: "b", text: "B" }]);
    t.advance(5);
    await t.sched.tick();
    expect(t.deps.addTodo).not.toHaveBeenCalled(); // new source = seed again, fire nothing
  });

  it("enableWatch checks again, seeds from that check, optionally queues, then saves enabled", async () => {
    const t = setup([queue({ enabled: false })]);
    t.setItems([{ id: "a", text: "A" }, { id: "b", text: "B" }]);
    expect(await t.sched.enableWatch("prs", true)).toEqual({ count: 2 });
    expect(t.deps.addTodo).toHaveBeenCalledTimes(2);
    expect(t.deps.saveRoutine).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(t.deps.watchSeen!.markNew("prs", ["a", "b", "c"])).toEqual(["c"]);
  });

  it("checkNow polls immediately; runNow refuses a notify-only watch", async () => {
    const t = setup([notify()]);
    await t.sched.tick(); // seed
    t.setItems([{ id: "n", text: "N" }]);
    expect(await t.sched.checkNow("yt")).toEqual({ newItems: 1 });
    expect((await t.sched.runNow("yt")).started).toBe(false);
  });

  it("never marks a watch routine missed", async () => {
    vi.useFakeTimers();
    const t = setup([notify()]);
    await t.deps.saveStates({ yt: { history: [], lastRun: new Date(2026, 0, 1).toISOString() } });
    t.sched.start();
    await vi.runOnlyPendingTimersAsync();
    expect(t.states().yt?.missed).toBeUndefined();
    t.sched.stop();
    vi.useRealTimers();
  });

  it("at-least-once: a failed todo insert marks nothing seen, reports the failure, and retries next poll", async () => {
    let failInsert = true;
    const t = setup([queue()], {
      addTodo: vi.fn(async () => { if (failInsert) throw new Error("database is locked"); }),
    });
    await t.sched.tick(); // seed (empty)
    t.setItems([{ id: "pr1", text: "PR 1" }]);
    t.advance(5);
    await t.sched.tick();
    expect(t.states().prs?.pollError).toMatch(/locked/);
    failInsert = false;
    t.advance(5);
    await t.sched.tick();
    expect(t.deps.addTodo).toHaveBeenCalledTimes(2); // offered again, not dropped
    expect(t.states().prs?.pollError).toBeUndefined();
  });

  it("drops a poll's results when the source was edited while it was in flight", async () => {
    const routines = [notify()];
    const t = setup(routines, {
      pollWatch: vi.fn(async () => {
        routines[0] = notify({ watch: { kind: "feed", url: "https://edited", everyMinutes: 15 } });
        return [{ id: "old", text: "Old" }];
      }),
    });
    await t.sched.tick();
    expect(t.states().yt?.lastPoll).toBeUndefined(); // nothing seeded or stamped for the new source
  });

  it("a throwing due check doesn't leave the routine stuck as running", async () => {
    let boom = true;
    const t = setup([queue()], { hasPendingTodos: async () => { if (boom) throw new Error("locked"); return false; } });
    await t.sched.tick();
    expect(t.sched.isRunning("prs")).toBe(false);
    boom = false;
    t.advance(5);
    await t.sched.tick();
    expect(t.deps.pollWatch).toHaveBeenCalledTimes(2);
  });

  it("enableWatch with queueExisting leaves the watch unseeded when a queue insert fails", async () => {
    const t = setup([queue({ enabled: false })], { addTodo: vi.fn(async () => { throw new Error("locked"); }) });
    t.setItems([{ id: "a", text: "A" }]);
    await expect(t.sched.enableWatch("prs", true)).rejects.toThrow(/locked/);
    expect(t.deps.watchSeen!.isSeeded("prs", "command:gh …")).toBe(false); // still needs review
    expect(t.deps.saveRoutine).not.toHaveBeenCalled();
  });
});
