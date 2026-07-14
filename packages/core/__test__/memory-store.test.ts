import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadMemories, saveMemories, appendMemories, selectRelevantMemories } from "../src/memory/store.js";
import { closeDb } from "../src/db.js";
import { dbFile } from "../src/config.js";
import type { Memory } from "../src/memory/memory.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-memory-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const m = (id: string, text: string): Memory => ({ id, text, createdAt: "2026-07-03T00:00:00.000Z" });

test("a fresh db returns an empty array", async () => {
  expect(await loadMemories(file)).toEqual([]);
});

test("save then load round-trips and creates missing parent dirs", async () => {
  const nested = dbFile(join(dir, "nested"));
  const memories = [m("a", "prefers pnpm"), { ...m("b", "auth in core"), projectPath: "/work/api" }];
  await saveMemories(nested, memories);
  expect(await loadMemories(nested)).toEqual(memories);
  closeDb(nested);
});

test("saveMemories replaces the whole set, not an append", async () => {
  await saveMemories(file, [m("a", "one")]);
  await saveMemories(file, [m("b", "two")]);
  expect(await loadMemories(file)).toEqual([m("b", "two")]);
});

test("appendMemories adds without touching existing rows, unlike saveMemories", async () => {
  await saveMemories(file, [m("a", "one")]);
  await appendMemories(file, [m("b", "two")]);
  expect(await loadMemories(file)).toEqual([m("a", "one"), m("b", "two")]);
});

test("two concurrent appendMemories calls both survive (the race saveMemories loses)", async () => {
  await saveMemories(file, [m("base", "existing fact")]);
  await Promise.all([appendMemories(file, [m("a", "from A")]), appendMemories(file, [m("b", "from B")])]);
  const ids = (await loadMemories(file)).map((mm) => mm.id).sort();
  expect(ids).toEqual(["a", "b", "base"]);
});

// Regression for a PR review finding: `id` is a SQLite PRIMARY KEY, so two processes that
// generate an id from `${Date.now()}-${i}` in the same millisecond (same batch index) would
// collide and throw on the second INSERT — silently losing that batch's save behind a caught
// error, instead of the old JSON array's "duplicate id, no crash, no complaint" behavior.
// bot.ts and ChatWindow.tsx now generate ids with randomUUID(); this proves both halves.
test("a Date.now()-derived id collision throws (the vulnerability the PK constraint exposes)", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  await appendMemories(file, [{ id: "1752451200000-0", text: "from process A", createdAt: now }]);
  await expect(
    appendMemories(file, [{ id: "1752451200000-0", text: "from process B", createdAt: now }]),
  ).rejects.toThrow();
});

test("randomUUID()-derived ids never collide even under a frozen clock (the actual fix)", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  await Promise.all([
    appendMemories(file, [{ id: randomUUID(), text: "from process A", createdAt: now }]),
    appendMemories(file, [{ id: randomUUID(), text: "from process B", createdAt: now }]),
  ]);
  const ids = (await loadMemories(file)).map((mm) => mm.id);
  expect(new Set(ids).size).toBe(2);
});

test("legacy memory.json is migrated in on first open, invalid entries dropped", async () => {
  await writeFile(
    join(dir, "memory.json"),
    JSON.stringify([m("a", "keep"), { id: "", text: "drop", createdAt: "z" }]),
  );
  expect(await loadMemories(file)).toEqual([m("a", "keep")]);
});

test("invalid legacy memory.json migrates to an empty db instead of crashing", async () => {
  await writeFile(join(dir, "memory.json"), "{ not json");
  expect(await loadMemories(file)).toEqual([]);
});

test("selectRelevantMemories returns everything at or below the skip threshold", () => {
  const memories = Array.from({ length: 20 }, (_, i) => m(`id-${i}`, `fact ${i}`));
  expect(selectRelevantMemories(memories, "anything")).toEqual(memories);
});

test("selectRelevantMemories ranks by relevance above the threshold and force-includes the current project", () => {
  const memories = [
    ...Array.from({ length: 25 }, (_, i) => m(`filler-${i}`, `unrelated filler fact number ${i}`)),
    m("roadmap", "the Q3 roadmap ships auth work first"),
    { ...m("scoped", "internal note about billing"), projectPath: "/work/billing" },
  ];
  const picked = selectRelevantMemories(memories, "what's the roadmap say", "/work/billing", 5, 20);
  expect(picked.some((mm) => mm.id === "scoped")).toBe(true);
  expect(picked.some((mm) => mm.id === "roadmap")).toBe(true);
  expect(picked.length).toBeLessThanOrEqual(5);
});
