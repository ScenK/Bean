import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTodo, claimTodo, closeDispatch, deliverDispatches, dispatchNotice, getDispatch, interruptOpenDispatches,
  openDispatch, recoverInterruptedTodos, undeliveredDispatches, updateTodoStatus, withDispatch,
  type Dispatch, type TriggerOutcome,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-dispatch-"));
  file = join(dir, "bean.db");
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

/** A recording deliverer: what reached the origin, in order. */
const sink = () => {
  const sent: Dispatch[] = [];
  return { sent, deliver: async (d: Dispatch) => { sent.push(d); return true; } };
};

/** What a scheduler start does: close open rows, then deliver every owed one. */
const restart = async (deliver: (d: Dispatch) => Promise<boolean>): Promise<void> => {
  interruptOpenDispatches(file);
  await deliverDispatches(file, deliver);
};

describe("dispatch-store", () => {
  it("a restart between admission and the run's end gives one interrupted notice at the origin", async () => {
    const id = openDispatch(file, { surface: "teams", conversation: "c1", actor: "u1", routine: "digest" });
    const s = sink();
    await restart(s.deliver);
    await restart(s.deliver); // a second start owes nothing more
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ id, surface: "teams", conversation: "c1", actor: "u1", status: "interrupted" });
    expect(dispatchNotice(s.sent[0]!)).toMatch(/^digest was interrupted/);
    // The run's late completion (it can't, after a restart — but a duplicate can't reopen it either).
    expect(closeDispatch(file, id, { status: "ok" })).toBe(false);
  });

  it("a restart between the run's end and delivery delivers the stored result once", async () => {
    const id = openDispatch(file, { surface: "discord", routine: "digest" });
    expect(closeDispatch(file, id, { status: "ok", runIds: ["r1"], brief: "3 PRs merged" })).toBe(true);
    expect(closeDispatch(file, id, { status: "failed" })).toBe(false); // duplicate completion
    const s = sink();
    await restart(s.deliver);
    await deliverDispatches(file, s.deliver);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ status: "ok", runIds: ["r1"], brief: "3 PRs merged" });
    expect(s.sent[0]!.conversation).toBeUndefined(); // the owner's DM
    expect(dispatchNotice(s.sent[0]!)).toBe("digest finished ✓\n\n3 PRs merged");
  });

  it("concurrent sweeps send a row once; an origin that can't take it keeps it owed", async () => {
    const id = openDispatch(file, { surface: "desktop", conversation: "t1", routine: "digest" });
    closeDispatch(file, id, { status: "ok" });
    await deliverDispatches(file, async () => false);
    await deliverDispatches(file, async () => { throw new Error("boom"); });
    expect(undeliveredDispatches(file).map((d) => d.id)).toEqual([id]);
    const s = sink();
    await Promise.all([deliverDispatches(file, s.deliver), deliverDispatches(file, s.deliver)]);
    expect(s.sent).toHaveLength(1);
    expect(getDispatch(file, id)?.deliveredAt).toBeDefined();
  });

  it("an incognito origin stores no brief", async () => {
    const id = openDispatch(file, { surface: "desktop", conversation: "t1", routine: "digest", keepBrief: false });
    closeDispatch(file, id, { status: "ok", brief: "secret" });
    expect(getDispatch(file, id)?.brief).toBeUndefined();
  });

  it("a todo-linked row closes with its todo's own result; a still-pending todo survives a restart", async () => {
    const a = await addTodo(file, "q", "a");
    const b = await addTodo(file, "q", "b");
    const ida = openDispatch(file, { surface: "teams", routine: "q", todoId: a.id });
    const idb = openDispatch(file, { surface: "teams", routine: "q", todoId: b.id });
    expect(closeDispatch(file, ida, { status: "failed" })).toBe(false); // the trigger's end doesn't close it
    await claimTodo(file, "q");
    await updateTodoStatus(file, a.id, "done", "shipped it");
    expect(getDispatch(file, ida)).toMatchObject({ status: "ok", brief: "shipped it" });
    expect(interruptOpenDispatches(file)).toBe(0);
    expect(getDispatch(file, idb)?.status).toBeUndefined();
    // Its todo claimed, then the core died mid-run: recovery fails the todo, the row is interrupted.
    await claimTodo(file, "q");
    await recoverInterruptedTodos(file);
    expect(interruptOpenDispatches(file)).toBe(1);
    expect(getDispatch(file, idb)?.status).toBe("interrupted");
  });

  it("withDispatch records an admitted run with its origin and closes it at the end", async () => {
    let finish!: (o: TriggerOutcome) => void;
    const done = new Promise<TriggerOutcome>((r) => { finish = r; });
    const s = sink();
    let swept!: () => void;
    const delivered = new Promise<void>((r) => { swept = r; });
    const trigger = withDispatch(async () => ({ status: "started", done }), {
      file, surface: "teams", deliver: async () => { await deliverDispatches(file, s.deliver); swept(); },
    });
    expect((await trigger("digest", "run", { channel: "c1", actor: "u1" })).status).toBe("started");
    expect(undeliveredDispatches(file)).toEqual([]); // open, nothing owed yet
    finish({ status: "ok", runs: 1, ok: 1, needsAttention: 0, failed: 0, perRun: [{ id: "r1", status: "ok", brief: "done" }] });
    await delivered;
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ surface: "teams", conversation: "c1", actor: "u1", routine: "digest", runIds: ["r1"], brief: "done" });
  });

  it("withDispatch records nothing for a refused trigger", async () => {
    const trigger = withDispatch(async () => ({ status: "refused", reason: "busy" }), { file, surface: "teams", deliver: async () => {} });
    expect((await trigger("digest", "run", {})).status).toBe("refused");
    expect(interruptOpenDispatches(file)).toBe(0); // no row was opened
  });
});
