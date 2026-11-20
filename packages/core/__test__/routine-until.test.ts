// #980: `until`, the `done` ending, expiry, and the derived Archived state.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../src/routine-scheduler.js";
import { DONE_FOOTER } from "../src/routine-runner.js";
import {
  addTodo, describeRoutineError, dropPendingTodos, endReason, isArchived, isExpired, listTodos, resolveTodoRoutine,
  untilLabel, untilTime, claimTodo, queueTodoDispatch,
} from "../src/index.js";
import { closeDb, openDb } from "../src/db.js";
import type { Routine, RoutineRunResult, RoutineState, TodoItem, WatchItem } from "../src/index.js";

const DAY = 24 * 60 * 60_000;
const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);

describe("until and archived (store)", () => {
  it("a bare date ends with its local day; a date-time is that instant; nonsense is invalid", () => {
    expect(untilTime("2026-12-20")).toBe(at(2026, 12, 21).getTime());
    expect(untilTime("2026-12-20T10:00:00.000Z")).toBe(Date.parse("2026-12-20T10:00:00.000Z"));
    for (const bad of ["2026-02-30", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "Dec 20", "2026-12-20 10:00", "", "tomorrow"]) expect(untilTime(bad)).toBeUndefined();
    expect(untilLabel("2026-12-20")).toBe("Dec 20, 2026");
    const r: Routine = { name: "w", enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {} };
    expect(describeRoutineError({ ...r, until: "2026-12-20" })).toBeNull();
    expect(describeRoutineError({ ...r, until: "soon" })).toMatch(/until must be a date/);
    expect(describeRoutineError({ ...r, until: 5 })).toMatch(/until must be a date/);
  });

  it("expired = on and past until; archived = off and 7 days past it; a paused one within the grace stays live", () => {
    const until = "2026-12-20"; // ends 2026-12-21 00:00 local
    expect(isExpired({ enabled: true, until }, at(2026, 12, 20, 23, 59))).toBe(false);
    expect(isExpired({ enabled: true, until }, at(2026, 12, 21, 0, 1))).toBe(true);
    expect(isExpired({ enabled: false, until }, at(2027, 1, 1))).toBe(false);
    expect(isArchived({ enabled: false, until }, at(2026, 12, 27))).toBe(false);
    expect(isArchived({ enabled: false, until }, at(2026, 12, 28, 0, 1))).toBe(true);
    expect(isArchived({ enabled: true, until }, at(2027, 6, 1))).toBe(false);
    expect(isArchived({ enabled: false }, at(2027, 6, 1))).toBe(false);
  });

  it("why it ended: found only when a done run's finish is the current until", () => {
    const now = at(2026, 12, 25);
    const foundAt = "2026-12-20T10:00:00.000Z";
    const rec = (over: object) => ({ startedAt: "x", finishedAt: foundAt, status: "ok" as const, digest: "", steps: [], ...over });
    // A sibling recorded after the done run doesn't change it.
    const done: RoutineState = { history: [rec({ finishedAt: "2026-12-20T10:05:00.000Z" }), rec({ done: true })] };
    expect(endReason({ enabled: false, until: foundAt }, done, now)).toBe("found");
    // Restored with a later until that then passed: expired, though an old done run is in history.
    expect(endReason({ enabled: false, until: "2026-12-22" }, done, now)).toBe("expired");
    expect(endReason({ enabled: false, until: "2026-12-20" }, { history: [] }, now)).toBe("expired");
    expect(endReason({ enabled: false, until: "2027-01-20" }, done, now)).toBeUndefined(); // paused before its end
    expect(endReason({ enabled: true, until: foundAt }, done, now)).toBeUndefined();
  });

  it("an archived sprout takes no todos; a paused one within the grace still does", () => {
    const base: Routine = { name: "w", enabled: false, until: "2026-12-20", cron: "0 9 * * *", todoDriven: true, steps: [{ kind: "chat", instruction: "x" }], sinks: {} };
    expect(resolveTodoRoutine([base], "w", false, at(2026, 12, 22)).name).toBe("w");
    expect(() => resolveTodoRoutine([base], "w", false, at(2027, 1, 5))).toThrow(/no sprout named "w"/);
  });

  it("dropPendingTodos removes only the sprout's pending todos and their open dispatch rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bean-until-"));
    const file = join(dir, "bean.db");
    try {
      await addTodo(file, "w", "running one");
      await claimTodo(file, "w");
      await addTodo(file, "w", "pending one");
      const q = queueTodoDispatch(file, { routine: "w", text: "from chat" }, { surface: "discord", conversation: "c1" });
      await addTodo(file, "other", "not mine");
      expect(openDb(file).prepare("SELECT count(*) AS n FROM sprout_dispatches WHERE id = ?").get(q.jobId)).toEqual({ n: 1 });
      expect(await dropPendingTodos(file, "w")).toBe(2);
      expect((await listTodos(file, "w")).map((t) => [t.text, t.status])).toEqual([["running one", "running"]]);
      expect((await listTodos(file, "other")).length).toBe(1);
      expect(openDb(file).prepare("SELECT count(*) AS n FROM sprout_dispatches WHERE id = ?").get(q.jobId)).toEqual({ n: 0 });
    } finally {
      closeDb(file);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function setup(initial: Routine[], over: Partial<RoutineSchedulerDeps> = {}) {
  let routines = initial;
  let states: Record<string, RoutineState> = {};
  let clock = at(2026, 12, 10, 9, 0);
  let items: WatchItem[] = [];
  const queue: TodoItem[] = [];
  const seeded: string[][] = [];
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => routines,
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine: vi.fn(async (): Promise<RoutineRunResult> => {
      queue.length = 0; // a drain takes everything
      const record = { startedAt: clock.toISOString(), finishedAt: clock.toISOString(), status: "ok" as const, digest: "ran", steps: [] };
      return { record, digest: "ran", results: [] };
    }),
    deliverDigest: vi.fn(async () => {}),
    now: () => clock,
    hasPendingTodos: async () => queue.length > 0,
    claimTodo: async () => queue.shift(),
    claimTodoById: async (id) => { const i = queue.findIndex((t) => t.id === id); return i < 0 ? undefined : queue.splice(i, 1)[0]; },
    pollWatch: vi.fn(async () => items),
    watchSeen: {
      isSeeded: () => true,
      seed: (_r, _s, ids) => { seeded.push(ids); },
      unseen: (_r, ids) => ids,
      markNew: () => [],
    },
    addTodo: vi.fn(async () => {}),
    saveRoutine: vi.fn(async (r: Routine) => { routines = routines.map((x) => (x.name === r.name ? r : x)); }),
    dropPendingTodos: vi.fn(async () => { queue.length = 0; }),
    ...over,
  };
  return {
    deps, sched: createRoutineScheduler(deps), queue, seeded, states: () => states,
    setRoutines: (next: Routine[]) => { routines = next; },
    routine: (name: string) => routines.find((r) => r.name === name)!,
    setClock: (d: Date) => { clock = d; },
    setItems: (next: WatchItem[]) => { items = next; },
  };
}

const todo = (id: string): TodoItem => ({ id, routine: "w", text: `item ${id}`, status: "pending", createdAt: "x", order: 0 });
const FOUND_AT = "2026-12-10T17:05:00.000Z";
const doneResult = (digest = "found it", todo?: string): RoutineRunResult => ({
  record: { id: `run-${digest}`, startedAt: "2026-12-10T17:00:00.000Z", finishedAt: FOUND_AT, status: "ok", digest: `${digest}\n\n${DONE_FOOTER}`, steps: [], done: true },
  digest: `${digest}\n\n${DONE_FOOTER}`, footer: `\n\n${DONE_FOOTER}`, ending: "done",
  results: todo ? [{ index: 0, kind: "chat", ok: true, output: digest, todo }] : [],
});
const watchQueue = (over: Partial<Routine> = {}): Routine => ({
  name: "w", enabled: true, todoDriven: true, watch: { kind: "feed", url: "https://f", everyMinutes: 15 },
  steps: [{ kind: "chat", instruction: "judge" }], sinks: {}, ...over,
});

describe("the done ending (scheduler)", () => {
  it("delivers once, then pauses with until = now, drops the queue and admits nothing more", async () => {
    const t = setup([watchQueue({ until: "2026-12-31" })]);
    t.queue.push(todo("a"), todo("b"));
    vi.mocked(t.deps.runRoutine).mockResolvedValueOnce(doneResult());
    const res = await t.sched.runNow("w");
    expect(res.started).toBe(true);
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.deps.deliverDigest).mock.calls[0]![1]).toMatchObject({ ending: "done" });
    expect(t.routine("w")).toMatchObject({ enabled: false, until: FOUND_AT });
    expect(t.deps.dropPendingTodos).toHaveBeenCalledWith("w");
    expect(t.queue).toEqual([]);
    // Paused: the next tick admits nothing.
    t.queue.push(todo("c"));
    await t.sched.tick();
    expect(t.deps.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("two parallel workers both reaching done: one owns the ending, the other delivers as an ordinary run", async () => {
    const t = setup([watchQueue({ maxParallel: 2 })]);
    t.queue.push(todo("a"), todo("b"), todo("c"));
    let releaseA: () => void = () => {};
    vi.mocked(t.deps.runRoutine).mockImplementation(async (_r, item) => {
      if (item?.id === "a") await new Promise<void>((res) => { releaseA = res; });
      return doneResult(`found by ${item?.id}`);
    });
    const run = t.sched.runNow("w");
    await vi.waitFor(() => expect(t.deps.dropPendingTodos).toHaveBeenCalled()); // b owned it
    releaseA();
    await run;
    expect(vi.mocked(t.deps.runRoutine).mock.calls.map((c) => c[1]?.id)).toEqual(["a", "b"]);
    const delivered = vi.mocked(t.deps.deliverDigest).mock.calls.map((c) => [c[1].digest, c[1].ending]);
    expect(delivered).toEqual([[`found by b\n\n${DONE_FOOTER}`, "done"], ["found by a", undefined]]);
    expect(t.deps.saveRoutine).toHaveBeenCalledTimes(1);
    expect(t.deps.dropPendingTodos).toHaveBeenCalledTimes(1);
  });

  it("a failed done delivery: the run needs attention, the sprout pauses with its queue kept, nothing re-delivers", async () => {
    const t = setup([watchQueue()]);
    t.queue.push(todo("a"), todo("b"));
    vi.mocked(t.deps.runRoutine).mockImplementationOnce(async () => doneResult("found it", "item a"));
    vi.mocked(t.deps.deliverDigest).mockRejectedValueOnce(new Error("outbox locked"));
    const res = await t.sched.runNow("w");
    expect(res).toMatchObject({ started: true, status: "needs-attention" });
    expect(t.routine("w").enabled).toBe(false);
    expect(t.routine("w").until).toBeUndefined(); // paused, not ended: the owner retries or clears
    expect(t.deps.dropPendingTodos).not.toHaveBeenCalled();
    expect(t.queue.map((q) => q.id)).toEqual(["a", "b"]);
    expect(t.states().w!.history[0]).toMatchObject({ status: "needs-attention", done: true });
    expect(t.states().w!.history[0]!.digest).toMatch(/couldn't deliver this \(outbox locked\) — paused with its queue kept/);
    await t.sched.tick();
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
    expect(t.deps.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("parallel workers claim nothing after a sibling's done; the sprout ends once", async () => {
    const t = setup([watchQueue({ maxParallel: 2 })]);
    t.queue.push(todo("a"), todo("b"), todo("c"), todo("d"));
    let release: () => void = () => {};
    vi.mocked(t.deps.runRoutine).mockImplementation(async (_r, item) => {
      if (item?.id === "a") return doneResult();
      await new Promise<void>((res) => { release = res; }); // b stays open until a's done lands
      return { record: { startedAt: "x", finishedAt: "x", status: "ok", digest: "b", steps: [] }, digest: "b", results: [] };
    });
    const run = t.sched.runNow("w");
    await vi.waitFor(() => expect(t.deps.dropPendingTodos).toHaveBeenCalled());
    release();
    await run;
    expect(vi.mocked(t.deps.runRoutine).mock.calls.map((c) => c[1]?.id)).toEqual(["a", "b"]);
    expect(t.deps.saveRoutine).toHaveBeenCalledTimes(1);
  });
});

describe("expiry (scheduler)", () => {
  it("ticking twice past until posts the expiry once and leaves the sprout paused", async () => {
    const t = setup([watchQueue({ until: "2026-12-20" })]);
    t.queue.push(todo("a"));
    t.setClock(at(2026, 12, 21, 9, 0));
    await t.sched.tick();
    await t.sched.tick();
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
    const [, result] = vi.mocked(t.deps.deliverDigest).mock.calls[0]!;
    expect(result).toMatchObject({ digest: "Nothing by Dec 20, 2026 — extend?", ending: "expired" });
    expect(t.routine("w")).toMatchObject({ enabled: false, until: "2026-12-20" });
    expect(t.deps.dropPendingTodos).toHaveBeenCalledTimes(1);
    expect(t.deps.runRoutine).not.toHaveBeenCalled();
    expect(t.deps.pollWatch).not.toHaveBeenCalled();
  });

  it("overlapping ticks post the expiry once: a tick stuck on another watch's poll re-reads before posting", async () => {
    let releasePoll: () => void = () => {};
    const slow = watchQueue({ name: "slow" });
    const t = setup([slow, watchQueue({ until: "2026-12-20" })], {
      pollWatch: vi.fn(async () => { await new Promise<void>((res) => { releasePoll = res; }); return []; }),
    });
    t.setClock(at(2026, 12, 21, 9, 0));
    const first = t.sched.tick(); // blocks in slow's poll, with w already on its expired list
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    await t.sched.tick(); // slow is already polling: this one expires w
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
    releasePoll();
    await first;
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
    expect(t.deps.saveRoutine).toHaveBeenCalledTimes(1);
  });

  it("a due sprout paused while the tick was busy isn't started", async () => {
    let releasePoll: () => void = () => {};
    const q = watchQueue({ name: "q", watch: { kind: "feed", url: "https://q" } });
    const t = setup([q, watchQueue({ name: "slow", watch: { kind: "feed", url: "https://slow" } })], {
      pollWatch: vi.fn(async (w) => {
        if (w.kind === "feed" && w.url === "https://slow") await new Promise<void>((res) => { releasePoll = res; });
        return [];
      }),
      hasPendingTodos: async (r) => r === "q",
    });
    const tick = t.sched.tick(); // q is due (pending work); then blocks in slow's poll
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalledTimes(2));
    t.setRoutines([{ ...q, enabled: false }, watchQueue({ name: "slow" })]);
    releasePoll();
    await tick;
    expect(t.deps.runRoutine).not.toHaveBeenCalled();
  });

  it("a poll in flight across the expiry hands nothing off (notify-only too)", async () => {
    let releasePoll: () => void = () => {};
    const notify = watchQueue({ steps: [], todoDriven: undefined, until: "2026-12-20" });
    const t = setup([notify], {
      pollWatch: vi.fn(async () => { await new Promise<void>((res) => { releasePoll = res; }); return [{ id: "new", text: "late item" }]; }),
    });
    t.setClock(at(2026, 12, 20, 23, 0));
    const check = t.sched.checkNow("w");
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    t.setClock(at(2026, 12, 21, 9, 0));
    await t.sched.tick(); // expired: posted and paused while the poll is still fetching
    expect(t.routine("w").enabled).toBe(false);
    releasePoll();
    expect(await check).toEqual({ newItems: 0 });
    expect(vi.mocked(t.deps.deliverDigest).mock.calls.map((c) => c[1].ending)).toEqual(["expired"]); // no digest after the end
  });

  it("a poll in flight when the sprout is paused hands nothing off", async () => {
    let releasePoll: () => void = () => {};
    const w = watchQueue();
    const t = setup([w], {
      pollWatch: vi.fn(async () => { await new Promise<void>((res) => { releasePoll = res; }); return [{ id: "new", text: "late item" }]; }),
    });
    const check = t.sched.checkNow("w");
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    t.setRoutines([{ ...w, enabled: false, until: "2026-12-09" }]);
    releasePoll();
    expect(await check).toEqual({ newItems: 0 });
    expect(t.deps.addTodo).not.toHaveBeenCalled();
  });

  it("only the lease holder expires; before until nothing happens", async () => {
    let held = false;
    const t = setup([watchQueue({ until: "2026-12-20" })], { canSchedule: () => held });
    t.setClock(at(2026, 12, 21, 9, 0));
    await t.sched.tick();
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
    expect(t.routine("w").enabled).toBe(true);
    held = true;
    t.setClock(at(2026, 12, 20, 23, 0));
    await t.sched.tick();
    expect(t.deps.deliverDigest).not.toHaveBeenCalled();
    t.setClock(at(2026, 12, 21, 0, 30));
    await t.sched.tick();
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(1);
  });

  it("a failed post leaves it on, so the next tick tries again (post first, then pause)", async () => {
    const t = setup([watchQueue({ until: "2026-12-20" })]);
    vi.mocked(t.deps.deliverDigest).mockRejectedValueOnce(new Error("disk full"));
    t.setClock(at(2026, 12, 21, 9, 0));
    await t.sched.tick();
    expect(t.routine("w").enabled).toBe(true);
    await t.sched.tick();
    expect(t.deps.deliverDigest).toHaveBeenCalledTimes(2);
    expect(t.routine("w").enabled).toBe(false);
  });
});

describe("archived admission (scheduler)", () => {
  const archived = watchQueue({ enabled: false, until: "2026-12-01" }); // clock 12-10 → 8+ days past
  it("Run now, trigger, Check now and exact-todo runs all refuse it", async () => {
    const t = setup([archived]);
    t.queue.push(todo("a"));
    expect(await t.sched.runNow("w")).toMatchObject({ started: false, reason: expect.stringMatching(/archived/) });
    expect(await t.sched.trigger("w", "run")).toMatchObject({ status: "refused", reason: expect.stringMatching(/archived/) });
    expect(await t.sched.trigger("w", "check")).toMatchObject({ status: "checked", result: { error: expect.stringMatching(/no watch sprout/) } });
    expect(await t.sched.checkNow("w")).toMatchObject({ error: expect.stringMatching(/no watch sprout/) });
    expect(await t.sched.runTodo("w", "a")).toMatchObject({ status: "refused", reason: expect.stringMatching(/archived/) });
    expect(t.deps.runRoutine).not.toHaveBeenCalled();
  });

  it("a paused one within the grace can still be run by hand", async () => {
    const t = setup([watchQueue({ enabled: false, until: "2026-12-08" })]);
    t.queue.push(todo("a"));
    expect(await t.sched.runNow("w")).toMatchObject({ started: true });
  });
});

describe("restore (enableWatch)", () => {
  it("re-enables with a later until, seeded from now: items published while it was off aren't judged", async () => {
    const t = setup([watchQueue({ enabled: false, until: "2026-12-01" })]);
    t.setItems([{ id: "missed-1", text: "while paused" }, { id: "missed-2", text: "also" }]);
    await t.sched.enableWatch("w", false, "2027-01-31");
    expect(t.routine("w")).toMatchObject({ enabled: true, until: "2027-01-31" });
    expect(t.seeded).toEqual([["missed-1", "missed-2"]]);
    expect(t.deps.addTodo).not.toHaveBeenCalled();
  });

  it("refuses when the end date has passed (it would only expire again), or isn't a date", async () => {
    const t = setup([watchQueue({ enabled: false, until: "2026-12-01" })]);
    await expect(t.sched.enableWatch("w", false)).rejects.toThrow(/end date has passed/);
    await expect(t.sched.enableWatch("w", false, "2026-12-05")).rejects.toThrow(/end date has passed/);
    await expect(t.sched.enableWatch("w", false, "later")).rejects.toThrow(/until must be a date/);
    expect(t.routine("w").enabled).toBe(false);
    expect(t.seeded).toEqual([]);
  });

  it("a poll admitted before a restore queues nothing: its items are stale", async () => {
    let releasePoll: () => void = () => {};
    const t = setup([watchQueue({ until: "2026-12-31" })], {
      pollWatch: vi.fn(async () => { await new Promise<void>((res) => { releasePoll = res; }); return [{ id: "old", text: "old item" }]; }),
    });
    const check = t.sched.checkNow("w");
    await vi.waitFor(() => expect(t.deps.pollWatch).toHaveBeenCalled());
    t.setRoutines([watchQueue({ until: "2027-01-31" })]); // ended and restored meanwhile
    releasePoll();
    expect(await check).toEqual({ newItems: 0 });
    expect(t.deps.addTodo).not.toHaveBeenCalled();
  });

  it("a run admitted before a restore can't end the restored sprout: delivered as an ordinary run", async () => {
    let release: () => void = () => {};
    const t = setup([watchQueue({ until: "2026-12-31" })]);
    t.queue.push(todo("a"));
    vi.mocked(t.deps.runRoutine).mockImplementationOnce(async () => {
      await new Promise<void>((res) => { release = res; });
      return doneResult();
    });
    const run = t.sched.runNow("w");
    await vi.waitFor(() => expect(t.deps.runRoutine).toHaveBeenCalled());
    t.setRoutines([watchQueue({ until: "2027-01-31" })]);
    release();
    await run;
    expect(t.routine("w")).toMatchObject({ enabled: true, until: "2027-01-31" });
    expect(vi.mocked(t.deps.deliverDigest).mock.calls.map((c) => [c[1].digest, c[1].ending])).toEqual([["found it", undefined]]);
    expect(t.deps.dropPendingTodos).not.toHaveBeenCalled();
  });

  it("a failed check leaves it ended", async () => {
    const t = setup([watchQueue({ enabled: false, until: "2026-12-01" })], { pollWatch: vi.fn(async () => { throw new Error("feed down"); }) });
    await expect(t.sched.enableWatch("w", false, "2027-01-31")).rejects.toThrow(/feed down/);
    expect(t.routine("w")).toMatchObject({ enabled: false, until: "2026-12-01" });
  });

  it("null clears the end date", async () => {
    const t = setup([watchQueue({ enabled: false, until: "2026-12-01" })]);
    await t.sched.enableWatch("w", false, null);
    expect(t.routine("w").enabled).toBe(true);
    expect(t.routine("w").until).toBeUndefined();
  });
});
