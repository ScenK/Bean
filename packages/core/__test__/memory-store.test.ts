import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories, saveMemories } from "../src/memory/store.js";
import type { Memory } from "../src/memory/memory.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-memory-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const m = (id: string, text: string): Memory => ({ id, text, createdAt: "2026-07-03T00:00:00.000Z" });

test("missing file returns an empty array", async () => {
  expect(await loadMemories(join(dir, "memory.json"))).toEqual([]);
});

test("invalid JSON returns an empty array", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, "{ not json");
  expect(await loadMemories(file)).toEqual([]);
});

test("a non-array payload returns an empty array", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, JSON.stringify({ id: "x" }));
  expect(await loadMemories(file)).toEqual([]);
});

test("invalid entries are dropped, valid ones kept", async () => {
  const file = join(dir, "memory.json");
  await writeFile(file, JSON.stringify([m("a", "keep"), { id: "", text: "drop", createdAt: "z" }]));
  expect(await loadMemories(file)).toEqual([m("a", "keep")]);
});

test("save then load round-trips and creates missing parent dirs", async () => {
  const file = join(dir, "nested", "memory.json");
  const memories = [m("a", "prefers pnpm"), { ...m("b", "auth in core"), projectPath: "/work/api" }];
  await saveMemories(file, memories);
  expect(await loadMemories(file)).toEqual(memories);
});
