import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemories, deleteMemories, meaningScores, selectRelevantMemories, updateMemory } from "../src/memory/store.js";
import { closeDb, openDb } from "../src/db.js";
import { dbFile } from "../src/config.js";
import type { Memory } from "../src/memory/memory.js";
import type { Embed } from "../src/openai-chat.js";

const DIMS = 1536;
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-meaning-"));
  file = dbFile(dir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const m = (id: string, text: string, extra: Partial<Memory> = {}): Memory => ({ id, text, createdAt: "2026-07-03T00:00:00.000Z", ...extra });

// A fake meaning space: "dentist" concepts share axis 0 in any language or wording; every other
// text gets its own axis, so it is orthogonal to the query.
const axisOf = (text: string): number => {
  if (/dentist|牙医|tooth doctor/.test(text)) return 0;
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % (DIMS - 1);
  return 1 + h;
};
const unit = (axis: number): Float32Array => { const v = new Float32Array(DIMS); v[axis] = 1; return v; };
function fakeEmbed(model = "fake-1"): Embed & { batches: string[][] } {
  const batches: string[][] = [];
  return Object.assign(async (texts: string[]) => { batches.push(texts); return texts.map((t) => unit(axisOf(t))); }, { model, batches });
}
const storedIds = (): string[] =>
  (openDb(file).prepare("SELECT id FROM memory_vectors ORDER BY id").all() as { id: string }[]).map((r) => r.id);

// 50 keyword fillers ("this is …" matches the query's "is"), then the two rows bm25 can't see.
const corpus = (): Memory[] => [
  m("cn", "我的牙医是张医生，在中山路"),
  m("synonym", "the tooth doctor on Main St"),
  ...Array.from({ length: 50 }, (_, i) => m(`f-${i}`, `this is filler fact ${i}`)),
];
const QUERY = "who is my dentist";
const OPTS = { limit: 5, skipThreshold: 20 };

test("meaning scores pull a cross-language and a different-word row into the top limit that bm25 alone misses", async () => {
  const memories = corpus();
  await appendMemories(file, memories);
  const plain = selectRelevantMemories(memories, QUERY, undefined, OPTS).map((x) => x.id);
  expect(plain).not.toContain("cn");
  expect(plain).not.toContain("synonym");

  const embed = fakeEmbed();
  const scores = await meaningScores(file, embed, memories, QUERY, OPTS);
  expect(scores?.get("cn")).toBeCloseTo(1);
  const fused = selectRelevantMemories(memories, QUERY, undefined, { ...OPTS, scores }).map((x) => x.id);
  expect(fused).toHaveLength(5);
  expect(fused).toEqual(expect.arrayContaining(["cn", "synonym"]));

  // Cached: the next call embeds only the query.
  await meaningScores(file, embed, memories, QUERY, OPTS);
  expect(embed.batches.at(-1)).toEqual([QUERY]);
});

test("rows without a score rank by bm25 only, and pins + project force-include are unchanged", async () => {
  const memories = [
    ...corpus(),
    ...Array.from({ length: 3 }, (_, i) => m(`you-${i}`, `owner pref ${i}`, { category: "You" })),
    m("proj", "billing internals", { projectPath: "/work/billing" }),
  ];
  const scores = new Map([["cn", 1]]);
  const opts = { ...OPTS, pinCategory: "You", pinLimit: 2, scores };
  const picked = selectRelevantMemories(memories, QUERY, "/work/billing", opts).map((x) => x.id);
  expect(picked.slice(0, 3)).toEqual(["you-1", "you-2", "proj"]);
  expect(picked).toContain("cn");
  expect(picked).toHaveLength(7);
});

test("meaningScores returns undefined (selection unchanged) on throw, malformed vector, timeout, abort and too few candidates", async () => {
  const memories = corpus();
  await appendMemories(file, memories);
  const make = (fn: (texts: string[]) => Promise<Float32Array[]>): Embed => Object.assign(fn, { model: "fake-1" });

  expect(await meaningScores(file, make(async () => { throw new Error("boom"); }), memories, QUERY, OPTS)).toBeUndefined();
  for (const bad of [new Float32Array(DIMS), Float32Array.from({ length: DIMS }, () => NaN), new Float32Array(10)]) {
    expect(await meaningScores(file, make(async (t) => t.map(() => bad)), memories, QUERY, OPTS)).toBeUndefined();
  }
  expect(await meaningScores(file, make(async (t) => t.slice(1).map((x) => unit(axisOf(x)))), memories, QUERY, OPTS)).toBeUndefined();
  expect(storedIds()).toEqual([]);

  const never = make(() => new Promise(() => {}));
  expect(await meaningScores(file, never, memories, QUERY, { ...OPTS, waitMs: 10 })).toBeUndefined();
  const ac = new AbortController();
  const pending = meaningScores(file, never, memories, QUERY, { ...OPTS, signal: ac.signal });
  ac.abort();
  expect(await pending).toBeUndefined();

  // 21 live unpinned candidates is the minimum; 20 (+ pinned + expired) makes no call.
  const spy = fakeEmbed();
  const few = [
    ...Array.from({ length: 20 }, (_, i) => m(`a-${i}`, `fact ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => m(`p-${i}`, `pin ${i}`, { category: "You" })),
    m("old", "expired", { expiresAt: "2020-01-01T00:00:00.000Z" }),
  ];
  expect(await meaningScores(file, spy, few, QUERY, { ...OPTS, pinCategory: "You" })).toBeUndefined();
  expect(spy.batches).toEqual([]);
});

test("pinned and expired rows are never embedded and a batch carries at most 256 rows", async () => {
  const memories = [
    ...Array.from({ length: 300 }, (_, i) => m(`r-${i}`, `row ${i}`)),
    m("pin", "pinned row", { category: "You" }),
    m("gone", "expired row", { expiresAt: "2020-01-01T00:00:00.000Z" }),
  ];
  await appendMemories(file, memories);
  const embed = fakeEmbed();
  const scores = await meaningScores(file, embed, memories, QUERY, { ...OPTS, pinCategory: "You" });
  const first = embed.batches[0]!;
  expect(first).toHaveLength(257);
  expect(first).not.toContain("pinned row");
  expect(first).not.toContain("expired row");
  // Newest first: the oldest 44 wait for the next call and have no score this time.
  expect(scores?.has("r-0")).toBe(false);
  expect(scores?.has("r-299")).toBe(true);
  await meaningScores(file, embed, memories, QUERY, { ...OPTS, pinCategory: "You" });
  expect(embed.batches[1]).toHaveLength(45);
});

test("an edited row is re-embedded, a deleted row's vector goes with it, and a row deleted mid-call gets none", async () => {
  const memories = corpus();
  await appendMemories(file, memories);
  const embed = fakeEmbed();
  await meaningScores(file, embed, memories, QUERY, OPTS);
  expect(storedIds()).toHaveLength(52);

  await updateMemory(file, "f-3", "this is an edited fact");
  const edited = memories.map((x) => (x.id === "f-3" ? { ...x, text: "this is an edited fact" } : x));
  await meaningScores(file, embed, edited, QUERY, OPTS);
  expect(embed.batches.at(-1)).toEqual([QUERY, "this is an edited fact"]);

  await deleteMemories(file, ["f-4"]);
  expect(storedIds()).not.toContain("f-4");

  // f-5's vector is stale (new model), and the row is deleted while the embed call is out.
  const other = Object.assign(async (texts: string[]) => {
    await deleteMemories(file, ["f-5"]);
    return texts.map((t) => unit(axisOf(t)));
  }, { model: "fake-2" });
  await meaningScores(file, other, edited.filter((x) => x.id !== "f-4"), QUERY, OPTS);
  expect(storedIds()).not.toContain("f-5");
});

test("a slow embedder still persists its vectors after the caller stopped waiting", async () => {
  const memories = corpus();
  await appendMemories(file, memories);
  let release = (): void => {};
  const slow = Object.assign((texts: string[]) => new Promise<Float32Array[]>((resolve) => {
    release = () => resolve(texts.map((t) => unit(axisOf(t))));
  }), { model: "fake-1" });
  expect(await meaningScores(file, slow, memories, QUERY, { ...OPTS, waitMs: 5 })).toBeUndefined();
  expect(storedIds()).toEqual([]);
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(storedIds()).toHaveLength(52);
});
