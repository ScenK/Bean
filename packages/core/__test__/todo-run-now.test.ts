// Task dispatch (#923): a todo card's Run now / Queue — the todo + dispatch row, the scheduler's
// exact-todo admission, and the bot→host bridge that carries only the job id.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerTodoRun, cancelPendingTodo, claimTodo, claimTodoById, createRoutineScheduler, getDispatch, interruptOpenDispatches,
  listTodos, parseRoutineTrigger, parseRoutineTriggerResult, queueTodoDispatch, updateTodoStatus,
  type Routine, type RoutineRunResult, type RoutineSchedulerDeps, type RoutineState, type TodoItem,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-run-now-"));
  file = join(dir, "bean.db");
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const origin = { surface: "teams" as const, conversation: "c1", actor: "u1" };

describe("queueTodoDispatch", () => {
  it("Queue goes to the back with N ahead; Run now goes to the front; each has an open todo-linked dispatch", async () => {
    const a = queueTodoDispatch(file, { routine: "q", text: "old 1" }, origin);
    const b = queueTodoDispatch(file, { routine: "q", text: "old 2" }, origin);
    const now = queueTodoDispatch(file, { routine: "q", text: "urgent", front: true }, origin);
    expect([a.ahead, b.ahead, now.ahead]).toEqual([0, 1, 0]);
    expect((await listTodos(file, "q")).map((t) => t.text)).toEqual(["urgent", "old 1", "old 2"]);
    expect((await claimTodo(file, "q"))?.text).toBe("urgent"); // a drain takes it next
    const d = getDispatch(file, now.jobId);
    expect(d).toMatchObject({ surface: "teams", conversation: "c1", actor: "u1", routine: "q", todoId: now.todo.id });
    expect(d?.status).toBeUndefined();
  });

  it("the row closes with that todo's own result, survives a restart while pending, and goes with a cancel", async () => {
    const run = queueTodoDispatch(file, { routine: "q", text: "a" }, origin);
    const waits = queueTodoDispatch(file, { routine: "q", text: "b" }, origin);
    const gone = queueTodoDispatch(file, { routine: "q", text: "c" }, origin);
    expect(await claimTodoById(file, run.todo.id)).toMatchObject({ id: run.todo.id, status: "running" });
    expect(await claimTodoById(file, run.todo.id)).toBeUndefined(); // one claim only
    await updateTodoStatus(file, run.todo.id, "done", "the answer");
    expect(getDispatch(file, run.jobId)).toMatchObject({ status: "ok", brief: "the answer" });
    expect(await cancelPendingTodo(file, gone.todo.id)).toBe(true);
    expect(getDispatch(file, gone.jobId)).toBeUndefined(); // never reported as interrupted
    expect(interruptOpenDispatches(file)).toBe(0);
    expect(getDispatch(file, waits.jobId)?.status).toBeUndefined();
  });
});

const d = (h: number, mi: number) => new Date(2026, 6, 12, h, mi);
const routine: Routine = { name: "q", enabled: true, cron: "30 6 * * *", todoDriven: true, steps: [{ kind: "chat", instruction: "x" }], sinks: {} };

/** A scheduler over an in-memory queue whose runs stay open until released. */
function rig(ids: string[]) {
  const queue: TodoItem[] = ids.map((id) => ({ id, routine: "q", text: id, status: "pending", createdAt: "x", order: 0 }));
  const open = new Map<string, () => void>();
  const started: string[] = [];
  let live = 0;
  let peak = 0;
  const runRoutine = vi.fn(async (_r: Routine, t?: TodoItem): Promise<RoutineRunResult> => {
    started.push(t?.id ?? "drain");
    live++; peak = Math.max(peak, live);
    await new Promise<void>((res) => open.set(t?.id ?? "drain", res));
    live--;
    const record = { id: `run-${t?.id}`, startedAt: "a", finishedAt: "b", status: "ok" as const, digest: "d", steps: [] };
    return { record, digest: "d", results: [] };
  });
  let states: Record<string, RoutineState> = { q: { lastRun: d(6, 0).toISOString(), history: [] } };
  const take = (id?: string): TodoItem | undefined => {
    const i = id === undefined ? 0 : queue.findIndex((t) => t.id === id);
    return i >= 0 && i < queue.length ? queue.splice(i, 1)[0] : undefined;
  };
  const deps: RoutineSchedulerDeps = {
    loadRoutines: async () => [routine],
    loadStates: async () => states,
    saveStates: async (s) => { states = s; },
    runRoutine,
    deliverDigest: vi.fn(async () => {}),
    now: () => d(6, 31),
    hasPendingTodos: async () => queue.length > 0,
    claimTodo: async () => take(),
    claimTodoById: async (id) => take(id),
  };
  return {
    sched: createRoutineScheduler(deps), queue, started, peak: () => peak,
    release: (id: string) => { open.get(id)?.(); open.delete(id); },
    openIds: () => [...open.keys()],
  };
}

describe("scheduler runTodo", () => {
  it("runs only the new task while older todos stay queued, and starts no drain after it", async () => {
    const t = rig(["old1", "old2", "new"]);
    const r = await t.sched.runTodo("q", "new");
    expect(r.status).toBe("started");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["new"]));
    expect(t.sched.runningCount("q")).toBe(1);
    t.release("new");
    const out = r.status === "started" ? await r.done : undefined;
    expect(out).toMatchObject({ runs: 1, status: "ok" });
    expect(t.started).toEqual(["new"]);
    expect(t.queue.map((x) => x.id)).toEqual(["old1", "old2"]);
    expect(t.sched.runningCount("q")).toBe(0);
  });

  it("busy: the running task finishes untouched and the waiting one runs next, ahead of older ones", async () => {
    const t = rig(["a", "old", "b"]);
    await t.sched.runTodo("q", "a");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["a"]));
    expect(await t.sched.runTodo("q", "b")).toEqual({ status: "next" });
    expect(t.started).toEqual(["a"]); // nothing interrupted, nothing extra started
    t.release("a");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["b"]));
    t.release("b");
    await vi.waitFor(() => expect(t.sched.runningCount("q")).toBe(0));
    expect(t.started).toEqual(["a", "b"]);
    expect(t.queue.map((x) => x.id)).toEqual(["old"]);
    expect(t.peak()).toBe(1);
  });

  it("busy: two waiting Run nows start in queue order, the later one first", async () => {
    const t = rig(["c", "b", "a"]); // each Run now went in front of the last: c, then b, then a
    await t.sched.runTodo("q", "a");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["a"]));
    expect(await t.sched.runTodo("q", "b")).toEqual({ status: "next" });
    expect(await t.sched.runTodo("q", "c")).toEqual({ status: "next" });
    t.release("a");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["c"]));
    t.release("c");
    await vi.waitFor(() => expect(t.openIds()).toEqual(["b"]));
    t.release("b");
    await vi.waitFor(() => expect(t.sched.runningCount("q")).toBe(0));
    expect(t.started).toEqual(["a", "c", "b"]);
  });

  it("racing a scheduled drain: one slot, and the task runs once", async () => {
    const t = rig(["new"]);
    const tick = t.sched.tick(); // due: the drain takes the slot
    const r = await t.sched.runTodo("q", "new");
    await vi.waitFor(() => expect(t.openIds()).toHaveLength(1));
    expect(t.sched.runningCount("q")).toBe(1);
    // Whichever got the slot, the other waits: release until both settle.
    for (let i = 0; i < 5 && t.openIds().length > 0; i++) {
      for (const id of t.openIds()) t.release(id);
      await new Promise((res) => setTimeout(res, 5));
    }
    await tick;
    if (r.status === "started") await r.done;
    expect(t.peak()).toBe(1);
    expect(t.started.filter((id) => id === "new")).toEqual(["new"]);
    expect(t.sched.runningCount("q")).toBe(0);
  });

  it("refuses a sprout that doesn't take tasks", async () => {
    const t = rig([]);
    expect((await t.sched.runTodo("nope", "x")).status).toBe("refused");
  });
});

describe("bridge: Run now carries the job id, never the task text", () => {
  it("parses a todo trigger only with a job id, and the `next` answer", () => {
    const base = { type: "routine-trigger", requestId: "r", name: "q", action: "todo", origin: {} };
    expect(parseRoutineTrigger(base)).toBeUndefined();
    expect(parseRoutineTrigger({ ...base, job: "j1", text: "secret" })).toEqual({ ...base, job: "j1" });
    expect(parseRoutineTrigger({ ...base, action: "run", job: "j1" })).toBeUndefined();
    expect(parseRoutineTriggerResult({ type: "routine-trigger-result", requestId: "r", status: "next" })).toEqual({ type: "routine-trigger-result", requestId: "r", status: "next" });
  });

  it("answers from the dispatch row: unknown, standby, a todo a drain already took, and the scheduler's answer", async () => {
    const runTodo = vi.fn(async () => ({ status: "next" as const }));
    const deps = { file, held: () => true, runTodo };
    expect(await answerTodoRun("nope", deps)).toEqual({ status: "refused", reason: "missing" });
    const q = queueTodoDispatch(file, { routine: "q", text: "t", front: true }, origin);
    expect(await answerTodoRun(q.jobId, { ...deps, held: () => false })).toEqual({ status: "refused", reason: "standby" });
    expect(await answerTodoRun(q.jobId, deps)).toEqual({ status: "next" });
    expect(runTodo).toHaveBeenCalledWith("q", q.todo.id);
    await claimTodoById(file, q.todo.id);
    await updateTodoStatus(file, q.todo.id, "done", "ok");
    expect(await answerTodoRun(q.jobId, deps)).toEqual({ status: "started" });
    expect(runTodo).toHaveBeenCalledOnce();
  });
});
