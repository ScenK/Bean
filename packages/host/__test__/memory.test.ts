import { expect, test, vi } from "vitest";
import { buildMemoryHandlers } from "../src/index.js";
import type { ChatTurn, Memory, MemoryCandidate } from "@bean/core";

function memoryHandlersFor(over: Partial<Parameters<typeof buildMemoryHandlers>[0]> = {}) {
  const appended: Memory[][] = [];
  const deleted: string[][] = [];
  const batches: Memory[][] = [];
  let failures = 0;
  const existing: Memory[] = [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const handlers = buildMemoryHandlers({
    loadMemories: async () => existing,
    appendMemories: async (_file, additions) => { appended.push(additions); },
    updateMemory: async () => {},
    deleteMemories: async (_file, ids) => { deleted.push(ids); return ids; },
    extractMemories: async (transcript, ex, projects) => {
      expect(ex).toEqual(existing);
      expect(projects).toEqual([{ name: "api", path: "/work/api" }]);
      return { candidates: transcript.length ? [{ text: "new fact", projectPath: undefined }] : [], rejected: 0, failed: false };
    },
    loadProjects: async () => [{ name: "api", path: "/work/api" }],
    converse: async () => ({ content: "", toolCalls: [] }),
    getModel: () => "m",
    autoMemory: () => true,
    onMemoryBatch: (b) => { batches.push(b); },
    onMemoryFailure: () => { failures++; },
    getLastDream: async () => undefined,
    restoreDreamRun: async () => ({ restored: 0, skipped: 0 }),
    dreamDetails: async () => [],
    dbFile: "/b/bean.db",
    projectsFile: "/b/projects.json",
    ...over,
  });
  return { handlers, appended, deleted, batches, existing, failures: () => failures };
}

const typed: ChatTurn[] = [{ role: "user", content: "I prefer pnpm", source: "typed" }];

test("rememberOnClose extracts and appends in the background, then Undo deletes exactly that batch", async () => {
  const { handlers, appended, deleted, batches } = memoryHandlersFor();
  const batch = await handlers.rememberOnClose(typed, {});
  expect(batch.map((m) => m.text)).toEqual(["new fact"]);
  expect(appended).toEqual([batch]);
  expect(batches).toEqual([batch]);
  expect(handlers.batch()?.ids).toEqual(batch.map((m) => m.id));
  expect(await handlers.undoBatch()).toBe(1);
  expect(deleted).toEqual([batch.map((m) => m.id)]);
  expect(handlers.batch()).toBeUndefined();
  expect(await handlers.undoBatch()).toBe(0);
});

test("an incognito chat writes nothing and never calls extraction", async () => {
  let extracted = false;
  const { handlers, appended, batches, failures } = memoryHandlersFor({ extractMemories: async () => { extracted = true; return { candidates: [], rejected: 0, failed: true }; } });
  expect(await handlers.rememberOnClose(typed, { incognito: true })).toEqual([]);
  expect(extracted).toBe(false);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
});

test("autoMemory off means no background extraction", async () => {
  let extracted = false;
  const { handlers, appended, batches, failures } = memoryHandlersFor({ autoMemory: () => false, extractMemories: async () => { extracted = true; return { candidates: [], rejected: 0, failed: true }; } });
  expect(await handlers.rememberOnClose(typed, {})).toEqual([]);
  expect(extracted).toBe(false);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
});

test("Undo last dream restores the recorded run once; an undone or absent run is a no-op", async () => {
  const restored: string[] = [];
  let digest: { runId: string; at: string; merged: number; rewritten: number; removed: number; undone?: boolean } | undefined =
    { runId: "r1", at: "2026-09-01T00:00:00.000Z", merged: 1, rewritten: 0, removed: 2 };
  const { handlers } = memoryHandlersFor({
    getLastDream: async () => digest,
    restoreDreamRun: async (_f, runId) => { restored.push(runId); return { restored: 2, skipped: 1 }; },
  });
  expect(await handlers.undoLastDream()).toEqual({ restored: 2, skipped: 1 });
  digest = { ...digest!, undone: true };
  expect(await handlers.undoLastDream()).toEqual({ restored: 0, skipped: 0 });
  digest = undefined;
  expect(await handlers.undoLastDream()).toEqual({ restored: 0, skipped: 0 });
  expect(restored).toEqual(["r1"]);
});

test("no candidates means no batch and no bubble", async () => {
  const { handlers, batches, failures } = memoryHandlersFor({ extractMemories: async () => ({ candidates: [], rejected: 2, failed: false }) });
  expect(await handlers.rememberOnClose(typed, {})).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
  expect(handlers.batch()).toBeUndefined();
});

test("a failed extraction model call raises exactly one failure bubble", async () => {
  const { handlers, appended, batches, failures } = memoryHandlersFor({ extractMemories: async () => ({ candidates: [], rejected: 0, failed: true }) });
  await expect(handlers.rememberOnClose(typed, {})).rejects.toThrow(/extraction/);
  expect(failures()).toBe(1);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
});

test("a store failure raises exactly one failure bubble and leaves no Undo batch", async () => {
  const { handlers, batches, failures } = memoryHandlersFor({ appendMemories: async () => { throw new Error("SQLITE_BUSY"); } });
  await expect(handlers.rememberOnClose(typed, {})).rejects.toThrow("SQLITE_BUSY");
  expect(failures()).toBe(1);
  expect(batches).toEqual([]);
  expect(handlers.batch()).toBeUndefined();
});

const turnReq = { history: [], message: "I live in Seattle", source: "typed" as const, turnId: "item-1" };
const reply = { reply: "Nice!" };

test("captureTurn saves only the latest typed turn, after the reply, and close catch-up skips it", async () => {
  const calls: { transcript: ChatTurn[]; opts?: { latestTurn?: boolean; categorize?: boolean } }[] = [];
  const turnBatches: string[][] = [];
  const { handlers, appended, batches } = memoryHandlersFor({
    extractMemories: async (transcript, _ex, _p, _d, opts) => {
      calls.push({ transcript, opts });
      return { candidates: transcript.some((t) => t.source === "typed") ? [{ text: "Lives in Seattle", category: "You" }] : [], rejected: 0, failed: false };
    },
    onTurnBatch: (pendingIds) => { turnBatches.push(pendingIds()); },
  });
  const saved = await handlers.captureTurn("m7", turnReq, reply);
  expect(saved.map((m) => m.text)).toEqual(["Lives in Seattle"]);
  // The desktop is an owner path (#648): extraction categorizes and the row keeps the category.
  expect(calls[0]).toEqual({ transcript: [{ role: "user", content: "I live in Seattle", source: "typed" }], opts: { latestTurn: true, categorize: true } });
  expect(saved[0]?.category).toBe("You");
  expect(appended).toEqual([saved]);
  // Dream sees the still-undoable per-turn ids as pending.
  expect(turnBatches).toEqual([saved.map((m) => m.id)]);
  expect(batches).toEqual([]); // no avatar bubble — the chat row is the receipt

  // Close: the captured turn is context only, so nothing is citable and nothing is re-saved.
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { key: "m7" })).toEqual([]);
  expect(calls[1]?.transcript).toEqual([{ role: "user", content: "I live in Seattle", source: undefined }]);
  // An uncaptured turn (another id) is still caught up.
  expect(await handlers.rememberOnClose([{ role: "user", content: "I use vim", source: "typed", id: "item-9" }], { key: "m7" })).toHaveLength(1);
});

test("captureTurn skips incognito, autoMemory off, non-typed, errored, and explicit-remember turns", async () => {
  let extracted = 0;
  const count = { extractMemories: async () => { extracted++; return { candidates: [], rejected: 0, failed: false }; } };
  const { handlers } = memoryHandlersFor(count);
  expect(await handlers.captureTurn("m1", { ...turnReq, incognito: true }, reply)).toEqual([]);
  expect(await handlers.captureTurn("m1", { ...turnReq, source: "loopback" }, reply)).toEqual([]);
  expect(await handlers.captureTurn("m1", turnReq, { reply: "", error: "boom" })).toEqual([]);
  expect(await handlers.captureTurn("m1", turnReq, { reply: "ok", remembered: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] })).toEqual([]);
  const off = memoryHandlersFor({ ...count, autoMemory: () => false });
  expect(await off.handlers.captureTurn("m1", turnReq, reply)).toEqual([]);
  expect(extracted).toBe(0);
});

test("a turn that forgot something is marked handled, so close catch-up can't re-save the fact from its words", async () => {
  const calls: ChatTurn[][] = [];
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async (transcript) => {
      calls.push(transcript);
      return { candidates: transcript.some((t) => t.source === "typed") ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false };
    },
  });
  const forgot = { reply: "Done.", forgotten: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] };
  expect(await handlers.captureTurn("m3", { ...turnReq, message: "forget that I live in Seattle" }, forgot)).toEqual([]);
  expect(calls).toEqual([]); // no per-turn extraction either
  await handlers.rememberOnClose([{ role: "user", content: "forget that I live in Seattle", source: "typed", id: "item-1" }], { key: "m3" });
  expect(calls[0]).toEqual([{ role: "user", content: "forget that I live in Seattle", source: undefined }]);
  expect(appended).toEqual([]);
});

test("a failed per-turn capture is retried by close catch-up and raises no bubble itself", async () => {
  let fail = true;
  const { handlers, failures } = memoryHandlersFor({
    extractMemories: async (transcript) => (fail
      ? { candidates: [], rejected: 0, failed: true }
      : { candidates: transcript.some((t) => t.source === "typed") ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false }),
  });
  await expect(handlers.captureTurn("m3", turnReq, reply)).rejects.toThrow(/extraction/);
  expect(failures()).toBe(0);
  fail = false;
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { key: "m3" })).toHaveLength(1);
});

function deferredExtract() {
  const pending: Array<{ text: string; resolve: () => void }> = [];
  const extractMemories = (_t: ChatTurn[]) => new Promise<{ candidates: { text: string }[]; rejected: number; failed: boolean }>((resolve) => {
    const text = _t[_t.length - 1]!.content;
    pending.push({ text, resolve: () => resolve({ candidates: [{ text }], rejected: 0, failed: false }) });
  });
  return { pending, extractMemories };
}

test("switching the chip on while a capture is in flight saves nothing", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const capture = handlers.captureTurn("m4", turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  handlers.setIncognito("m4", true);
  d.pending[0]!.resolve();
  expect(await capture).toEqual([]);
  expect(appended).toEqual([]);
  // And later turns in that window are never sent to the model.
  expect(await handlers.captureTurn("m4", { ...turnReq, turnId: "item-3" }, reply)).toEqual([]);
  expect(d.pending).toHaveLength(1);
});

test("isIncognito reports each chat's live chip (delegate starts read it)", () => {
  const { handlers } = memoryHandlersFor({});
  expect(handlers.isIncognito("m5")).toBe(false);
  handlers.setIncognito("m5", true);
  expect(handlers.isIncognito("m5")).toBe(true);
  expect(handlers.isIncognito("m6")).toBe(false);
  handlers.setIncognito("m5", false);
  expect(handlers.isIncognito("m5")).toBe(false);
});

test("memory state is per chat mount: closing or releasing one leaves a new mount's capture working", async () => {
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async () => ({ candidates: [{ text: "Lives in Seattle" }], rejected: 0, failed: false }),
  });
  handlers.setIncognito("a", true);
  expect(handlers.isIncognito("b")).toBe(false); // A's chip latches A only
  expect(await handlers.rememberOnClose([], { key: "a", incognito: true })).toEqual([]);
  // The same thread reopened in a new mount B (same turn ids) still captures.
  expect(await handlers.captureTurn("b", turnReq, reply)).toHaveLength(1);
  handlers.release("b");
  expect(await handlers.captureTurn("b", turnReq, reply)).toEqual([]); // released: a late reply captures nothing
  expect(await handlers.captureTurn("c", turnReq, reply)).toHaveLength(1);
  expect(appended).toHaveLength(2);
});

test("a reply that settles after its window closed is never captured (close already covered it)", async () => {
  let extracted = 0;
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async () => { extracted++; return { candidates: [], rejected: 0, failed: false }; },
  });
  handlers.setIncognito("m8", true);
  // Closed incognito: catch-up writes nothing...
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { key: "m8", incognito: true })).toEqual([]);
  // ...and the late capture (request flag snapshotted before the chip) doesn't revive the window.
  expect(await handlers.captureTurn("m8", turnReq, reply)).toEqual([]);
  expect(extracted).toBe(0);
  expect(appended).toEqual([]);
});

test("closing incognito stops a capture already in flight, even if the chip IPC never arrived", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const capture = handlers.captureTurn("m9", turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { key: "m9", incognito: true })).toEqual([]);
  d.pending[0]!.resolve();
  expect(await capture).toEqual([]);
  expect(appended).toEqual([]);
});

test("captures in one window run in turn order, so a later fact is saved later", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const first = handlers.captureTurn("m5", turnReq, reply);
  const second = handlers.captureTurn("m5", { ...turnReq, message: "I live in Portland now", turnId: "item-3" }, reply);
  await new Promise((r) => setTimeout(r, 0));
  expect(d.pending.map((p) => p.text)).toEqual(["I live in Seattle"]); // second waits its turn
  d.pending[0]!.resolve();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  d.pending[1]!.resolve();
  await second;
  expect(appended.map((b) => b[0]!.text)).toEqual(["I live in Seattle", "I live in Portland now"]);
});

test("a capture that fails after its window closed raises the failure bubble (catch-up skipped it)", async () => {
  let fail!: () => void;
  const { handlers, failures } = memoryHandlersFor({
    extractMemories: (transcript) => (transcript.some((t) => t.source === "typed") && transcript.length === 1
      ? new Promise((resolve) => { fail = () => resolve({ candidates: [], rejected: 0, failed: true }); })
      : Promise.resolve({ candidates: [], rejected: 0, failed: false })),
  });
  const capture = handlers.captureTurn("m6", turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }, { role: "assistant", content: "Nice!" }], { key: "m6" });
  fail();
  await expect(capture).rejects.toThrow(/extraction/);
  expect(failures()).toBe(1);
});

test("facts undone in the window reach close catch-up as already remembered", async () => {
  let seen: Memory[] = [];
  const { handlers, existing } = memoryHandlersFor({
    extractMemories: async (_t, ex) => { seen = ex; return { candidates: [], rejected: 0, failed: false }; },
  });
  await handlers.rememberOnClose(typed, { rejected: ["Lives in Seattle"] });
  expect(seen.map((m) => m.text)).toEqual([...existing.map((m) => m.text), "Lives in Seattle"]);
});

test("list shows a channel capture under its current destination name, else its capture-time title", async () => {
  const rows: Memory[] = [
    { id: "a", text: "x", createdAt: "2026-07-03T00:00:00.000Z", sourceId: "teams:19:abc", sourceTitle: "Teams chat abc" },
    { id: "b", text: "y", createdAt: "2026-07-03T00:00:00.000Z", sourceId: "teams:19:gone", sourceTitle: "Teams chat gone" },
    { id: "c", text: "z", createdAt: "2026-07-03T00:00:00.000Z" },
  ];
  const { handlers } = memoryHandlersFor({
    loadMemories: async () => rows,
    sourceLabels: () => new Map([["teams:19:abc", "Task Force"]]),
  });
  expect((await handlers.list()).map((m) => m.sourceTitle)).toEqual(["Task Force", "Teams chat gone", undefined]);
});

test("settled waits for in-flight close catch-ups and turn captures, failed ones included (#862 quit)", async () => {
  const gates: Array<() => void> = [];
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async (transcript) => {
      await new Promise<void>((r) => gates.push(r));
      if (transcript.some((t) => t.content === "boom")) throw new Error("model down");
      return { candidates: [{ text: "new fact" }], rejected: 0, failed: false };
    },
  });
  await handlers.settled(); // nothing in flight
  const close = handlers.rememberOnClose(typed, { key: "a" });
  const failing = handlers.rememberOnClose([{ role: "user", content: "boom", source: "typed" }], { key: "b" }).catch(() => []);
  const turn = handlers.captureTurn("c", { message: "I prefer pnpm", history: [], source: "typed", turnId: "t1" } as never, {} as never);
  let done = false;
  const settled = handlers.settled().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  expect(done).toBe(false);
  while (gates.length < 3) await new Promise((r) => setTimeout(r, 0));
  for (const open of gates) open();
  await settled;
  expect(done).toBe(true);
  expect(appended).toHaveLength(2);
  await Promise.all([close, failing, turn]);
});
