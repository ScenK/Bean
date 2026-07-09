import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelMemory, saveModelMemory } from "../src/model-memory.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-model-memory-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns an empty object", async () => {
  expect(await loadModelMemory(join(dir, "model-memory.json"))).toEqual({});
});

test("invalid JSON returns an empty object", async () => {
  const file = join(dir, "model-memory.json");
  await writeFile(file, "{ not json");
  expect(await loadModelMemory(file)).toEqual({});
});

test("an array payload returns an empty object", async () => {
  const file = join(dir, "model-memory.json");
  await writeFile(file, JSON.stringify(["not", "an", "object"]));
  expect(await loadModelMemory(file)).toEqual({});
});

test("non-string values are dropped, string values kept", async () => {
  const file = join(dir, "model-memory.json");
  await writeFile(file, JSON.stringify({ summarize: "sonnet-4-5", broken: 42 }));
  expect(await loadModelMemory(file)).toEqual({ summarize: "sonnet-4-5" });
});

test("save then load round-trips and creates missing parent dirs", async () => {
  const file = join(dir, "nested", "model-memory.json");
  const memory = { summarize: "sonnet-4-5", "code-review": "opus-4-5" };
  await saveModelMemory(file, memory);
  expect(await loadModelMemory(file)).toEqual(memory);
});
