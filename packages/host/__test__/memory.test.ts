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
const turn = (id: string, content: string): ChatTurn & { id: string } => ({ role: "user", content, source: "typed", id });
const hasNew = (t: ChatTurn[]): boolean => t.some((x) => x.source === "typed");

test("a chat that went quiet writes one episode over the whole exchange; the close catch-up sees those turns as context", async () => {
  const calls: { transcript: ChatTurn[]; opts?: { categorize?: boolean } }[] = [];
  const turnBatches: string[][] = [];
  const { handlers, appended, batches } = memoryHandlersFor({
    extractMemories: async (transcript, _ex, _p, _d, opts) => {
      calls.push({ transcript, opts });
      return { candidates: hasNew(transcript) ? [{ text: "Lives in Seattle", category: "You", expiresAt: "2027-01-01T00:00:00.000Z", evidence: "You: I live in Seattle" }] : [], rejected: 0, failed: false };
    },
    onTurnBatch: (pendingIds) => { turnBatches.push(pendingIds()); },
  });
  expect(handlers.noteTurn("m7", turnReq, reply)).toBe(true);
  expect(calls).toEqual([]); // nothing per turn
  const episode = [turn("item-1", "I live in Seattle"), { role: "assistant" as const, content: "Nice!" }];
  const saved = await handlers.rememberIdle("m7", episode);
  // The desktop is an owner path (#648): extraction categorizes and the row keeps the category.
  expect(calls[0]).toEqual({
    transcript: [{ role: "user", content: "I live in Seattle", source: "typed" }, { role: "assistant", content: "Nice!" }], opts: { categorize: true },
  });
  expect(saved).toMatchObject([{ text: "Lives in Seattle", category: "You", expiresAt: "2027-01-01T00:00:00.000Z", evidence: "You: I live in Seattle" }]);
  expect(appended).toEqual([saved]);
  // Dream sees the still-undoable ids as pending.
  expect(turnBatches).toEqual([saved.map((m) => m.id)]);
  expect(batches).toEqual([]); // no avatar bubble — the chat row is the receipt

  // Quiet again with nothing new typed: the covered turn is context only.
  expect(await handlers.rememberIdle("m7", episode)).toEqual([]);
  expect(calls[1]?.transcript[0]).toEqual({ role: "user", content: "I live in Seattle", source: undefined });
  // Close: the same, and a turn typed since is still caught up.
  expect(await handlers.rememberOnClose([...episode, turn("item-9", "I use vim")], { key: "m7" })).toHaveLength(1);
  expect(calls[2]?.transcript.map((t) => t.source)).toEqual([undefined, undefined, "typed"]);
});

test("noteTurn watches only a typed, on-the-record, successful turn", () => {
  const { handlers } = memoryHandlersFor();
  expect(handlers.noteTurn("m1", { ...turnReq, incognito: true }, reply)).toBe(false);
  expect(handlers.noteTurn("m1", { ...turnReq, source: "loopback" }, reply)).toBe(false);
  expect(handlers.noteTurn("m1", turnReq, { reply: "", error: "boom" })).toBe(false);
  expect(memoryHandlersFor({ autoMemory: () => false }).handlers.noteTurn("m1", turnReq, reply)).toBe(false);
  handlers.setIncognito("m2", true);
  expect(handlers.noteTurn("m2", turnReq, reply)).toBe(false);
  handlers.release("m3");
  expect(handlers.noteTurn("m3", turnReq, reply)).toBe(false);
});

test("a turn that remembered or forgot something explicitly is covered, so no episode re-saves the fact from its words", async () => {
  const calls: ChatTurn[][] = [];
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async (transcript) => {
      calls.push(transcript);
      return { candidates: hasNew(transcript) ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false };
    },
  });
  const forgot = { reply: "Done.", forgotten: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] };
  handlers.noteTurn("m3", { ...turnReq, message: "forget that I live in Seattle" }, forgot);
  await handlers.rememberOnClose([turn("item-1", "forget that I live in Seattle")], { key: "m3" });
  expect(calls[0]).toEqual([{ role: "user", content: "forget that I live in Seattle", source: undefined }]);
  expect(appended).toEqual([]);
});

test("a chat's forgotten facts ride every later episode as already remembered, including the quit-path close", async () => {
  const seen: string[][] = [];
  const { handlers } = memoryHandlersFor({
    extractMemories: async (_t, ex) => { seen.push(ex.map((m) => m.text)); return { candidates: [], rejected: 0, failed: false }; },
  });
  const forgot = { reply: "Done.", forgotten: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] };
  handlers.noteTurn("f1", turnReq, reply);
  handlers.noteTurn("f1", { ...turnReq, message: "forget that", turnId: "item-2" }, forgot);
  const episode = [turn("item-1", "I live in Seattle"), turn("item-2", "forget that")];
  await handlers.rememberIdle("f1", episode);
  await handlers.rememberOnClose(episode, { key: "f1", rejected: [] });
  expect(seen).toEqual([["prefers pnpm", "Lives in Seattle"], ["prefers pnpm", "Lives in Seattle"]]);
});

test("an off-the-record forget is not tracked", async () => {
  const seen: string[][] = [];
  const forgot = { reply: "Done.", forgotten: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] };
  const { handlers } = memoryHandlersFor({
    extractMemories: async (_t, ex) => { seen.push(ex.map((m) => m.text)); return { candidates: [], rejected: 0, failed: false }; },
  });
  handlers.noteTurn("f2", turnReq, reply);
  handlers.noteTurn("f2", { ...turnReq, incognito: true, turnId: "item-2" }, forgot);
  await handlers.rememberIdle("f2", [turn("item-1", "I live in Seattle")]);
  expect(seen).toEqual([["prefers pnpm"]]);
  let on = true;
  const off = memoryHandlersFor({ autoMemory: () => on });
  on = false;
  off.handlers.noteTurn("f3", turnReq, forgot);
  on = true;
  expect(await off.handlers.rememberOnClose([turn("item-1", "x")], { key: "f3" })).toHaveLength(1); // default fake asserts no extras
});

test("a failed idle episode covers nothing: the close catch-up retries it, and it raises no bubble itself", async () => {
  let fail = true;
  const { handlers, failures } = memoryHandlersFor({
    extractMemories: async (transcript) => (fail
      ? { candidates: [], rejected: 0, failed: true }
      : { candidates: hasNew(transcript) ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false }),
  });
  handlers.noteTurn("m3", turnReq, reply);
  await expect(handlers.rememberIdle("m3", [turn("item-1", "I live in Seattle")])).rejects.toThrow(/extraction/);
  expect(failures()).toBe(0);
  fail = false;
  expect(await handlers.rememberOnClose([turn("item-1", "I live in Seattle")], { key: "m3" })).toHaveLength(1);
});

function deferredExtract() {
  const pending: Array<{ transcript: ChatTurn[]; resolve: () => void }> = [];
  const extractMemories = (t: ChatTurn[]) => new Promise<{ candidates: { text: string }[]; rejected: number; failed: boolean }>((resolve) => {
    pending.push({ transcript: t, resolve: () => resolve({ candidates: hasNew(t) ? [{ text: t.findLast((x) => x.source === "typed")!.content }] : [], rejected: 0, failed: false }) });
  });
  return { pending, extractMemories };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("switching the chip on while an episode is in flight saves nothing", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  handlers.noteTurn("m4", turnReq, reply);
  const episode = handlers.rememberIdle("m4", [turn("item-1", "I live in Seattle")]);
  await tick();
  handlers.setIncognito("m4", true);
  d.pending[0]!.resolve();
  expect(await episode).toEqual([]);
  expect(appended).toEqual([]);
  // And a later quiet spell in that chat is never sent to the model.
  expect(await handlers.rememberIdle("m4", [turn("item-3", "more")])).toEqual([]);
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

test("memory state is per chat mount: closing or releasing one leaves a new mount's episodes working", async () => {
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async () => ({ candidates: [{ text: "Lives in Seattle" }], rejected: 0, failed: false }),
  });
  const episode = [turn("item-1", "I live in Seattle")];
  handlers.setIncognito("a", true);
  expect(handlers.isIncognito("b")).toBe(false); // A's chip latches A only
  expect(await handlers.rememberOnClose([], { key: "a", incognito: true })).toEqual([]);
  // The same thread reopened in a new mount B (same turn ids) still writes.
  handlers.noteTurn("b", turnReq, reply);
  expect(await handlers.rememberIdle("b", episode)).toHaveLength(1);
  handlers.release("b");
  expect(await handlers.rememberIdle("b", episode)).toEqual([]); // released: a late timer writes nothing
  handlers.noteTurn("c", turnReq, reply);
  expect(await handlers.rememberIdle("c", episode)).toHaveLength(1);
  expect(appended).toHaveLength(2);
});

test("closing incognito stops an episode already in flight, even if the chip IPC never arrived", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  handlers.noteTurn("m9", turnReq, reply);
  const episode = handlers.rememberIdle("m9", [turn("item-1", "I live in Seattle")]);
  await tick();
  expect(await handlers.rememberOnClose([turn("item-1", "I live in Seattle")], { key: "m9", incognito: true })).toEqual([]);
  d.pending[0]!.resolve();
  expect(await episode).toEqual([]);
  expect(appended).toEqual([]);
});

test("a close waits for the episode in flight and reviews its turns itself, so nothing is written twice or without a receipt", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  handlers.noteTurn("m5", turnReq, reply);
  const first = [turn("item-1", "I live in Seattle")];
  const idle = handlers.rememberIdle("m5", first);
  const close = handlers.rememberOnClose([...first, turn("item-3", "I live in Portland now")], { key: "m5" });
  await tick();
  expect(d.pending).toHaveLength(1); // the close hasn't called the model yet
  d.pending[0]!.resolve();
  await idle;
  await tick();
  // The idle episode found its chat closed: it wrote nothing and covered nothing.
  expect(await idle).toEqual([]);
  expect(d.pending[1]!.transcript.map((t) => t.source)).toEqual(["typed", "typed"]);
  d.pending[1]!.resolve();
  await close;
  expect(appended.map((b) => b[0]!.text)).toEqual(["I live in Portland now"]);
});

test("a chat released while its episode is in flight writes nothing", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  handlers.noteTurn("m6", turnReq, reply);
  const idle = handlers.rememberIdle("m6", [turn("item-1", "I live in Seattle")]);
  await tick();
  handlers.release("m6");
  d.pending[0]!.resolve();
  expect(await idle).toEqual([]);
  expect(appended).toEqual([]);
});

test("autoMemory switched off while a close waits for the idle episode writes nothing", async () => {
  let auto = true;
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories, autoMemory: () => auto });
  handlers.noteTurn("m7", turnReq, reply);
  const idle = handlers.rememberIdle("m7", [turn("item-1", "I live in Seattle")]);
  const close = handlers.rememberOnClose([turn("item-1", "I live in Seattle")], { key: "m7" });
  await tick();
  auto = false;
  d.pending[0]!.resolve();
  expect(await idle).toEqual([]);
  expect(await close).toEqual([]);
  expect(d.pending).toHaveLength(1);
  expect(appended).toEqual([]);
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

test("settled waits for in-flight close catch-ups and idle episodes, failed ones included (#862 quit)", async () => {
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
  handlers.noteTurn("c", { message: "I prefer pnpm", history: [], source: "typed", turnId: "t1" } as never, {} as never);
  const idle = handlers.rememberIdle("c", [{ role: "user", content: "I prefer pnpm", source: "typed", id: "t1" }]);
  let done = false;
  const settled = handlers.settled().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  expect(done).toBe(false);
  while (gates.length < 3) await new Promise((r) => setTimeout(r, 0));
  for (const open of gates) open();
  await settled;
  expect(done).toBe(true);
  expect(appended).toHaveLength(2);
  await Promise.all([close, failing, idle]);
});
