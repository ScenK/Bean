import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.js";
import { dbFile } from "../src/config.js";
import {
  appendMemories, claimDreamLease, deleteMemories, dreamDetails, getMemoryMeta, loadMemories, restoreDreamRun,
  updateMemory, type DreamDigest,
} from "../src/memory/store.js";
import { maybeDream, planDream } from "../src/memory/dream.js";
import type { ConverseDeps, ToolCall } from "../src/converse.js";
import type { Memory } from "../src/memory/memory.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-dream-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const m = (id: string, text: string, createdAt = "2026-08-01T00:00:00.000Z", projectPath?: string): Memory =>
  ({ id, text, createdAt, projectPath });
const five = (): Memory[] => ["a", "b", "c", "d", "e"].map((id) => m(id, `fact ${id}`));

function chatCalling(toolCalls: ToolCall[], onCall?: () => Promise<void>): ConverseDeps["chat"] {
  return async () => { await onCall?.(); return { content: "", toolCalls }; };
}
const deps = (chat: ConverseDeps["chat"], nowMs = T0) => ({ dbFile: file, chat, model: "m", now: () => new Date(nowMs) });
const texts = async (): Promise<string[]> => (await loadMemories(file)).map((x) => x.text).sort();

test("dream needs ≥5 new memories and then waits 24h", async () => {
  await appendMemories(file, five().slice(0, 4));
  let calls = 0;
  const chat = chatCalling([{ name: "drop_memory", args: { id: "a" } }], async () => { calls++; });
  expect(await maybeDream(deps(chat))).toBeUndefined();
  expect(calls).toBe(0);

  await appendMemories(file, [m("e", "fact e")]);
  expect((await maybeDream(deps(chat)))?.removed).toBe(1);
  expect(calls).toBe(1);

  // Five more new facts, but under 24h later: no second run.
  await appendMemories(file, ["f", "g", "h", "i", "j"].map((id) => m(id, `fact ${id}`, new Date(T0 + 1000).toISOString())));
  expect(await maybeDream(deps(chat, T0 + DAY - 1))).toBeUndefined();
  expect(calls).toBe(1);
  expect(await maybeDream(deps(chatCalling([]), T0 + DAY + 1))).toBeUndefined(); // ran, but changed nothing
  expect(await getMemoryMeta(file, "lastDreamAt")).toBe(new Date(T0 + DAY + 1).toISOString());
});

test("two concurrent triggers commit exactly once", async () => {
  await appendMemories(file, five());
  let calls = 0;
  const chat = chatCalling([{ name: "drop_memory", args: { id: "a" } }], async () => { calls++; });
  const results = await Promise.all([maybeDream(deps(chat)), maybeDream(deps(chat))]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(calls).toBe(1);
  expect(await texts()).toEqual(["fact b", "fact c", "fact d", "fact e"]);
});

test("a live lease blocks a run; a stale one (>10 min) is taken over", async () => {
  await appendMemories(file, five());
  expect(await claimDreamLease(file, "crashed-run", T0 - 60_000, 10 * 60_000)).toBe(true);
  expect(await maybeDream(deps(chatCalling([{ name: "drop_memory", args: { id: "a" } }])))).toBeUndefined();
  const later = T0 - 60_000 + 10 * 60_000 + 1;
  expect((await maybeDream(deps(chatCalling([{ name: "drop_memory", args: { id: "a" } }]), later)))?.removed).toBe(1);
});

test("a memory appended mid-dream survives", async () => {
  await appendMemories(file, five());
  const chat = chatCalling(
    [{ name: "merge_memories", args: { ids: ["a", "b"], mergedText: "facts a and b" } }],
    () => appendMemories(file, [m("new", "said during the dream")]),
  );
  expect((await maybeDream(deps(chat)))?.merged).toBe(1);
  expect(await texts()).toEqual(["fact c", "fact d", "fact e", "facts a and b", "said during the dream"]);
});

test("a row edited mid-dream aborts the whole run with no partial mutation", async () => {
  await appendMemories(file, five());
  const chat = chatCalling(
    [
      { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "facts a and b" } },
      { name: "drop_memory", args: { id: "c" } },
    ],
    () => updateMemory(file, "c", "fact c, edited"),
  );
  expect(await maybeDream(deps(chat))).toBeUndefined();
  expect(await texts()).toEqual(["fact a", "fact b", "fact c, edited", "fact d", "fact e"]);
  expect(await getMemoryMeta(file, "lastDreamAt")).toBeUndefined();
});

test("planDream refuses cross-scope and overlapping merges and caps drops", () => {
  const mems = [
    m("g1", "global one"), m("g2", "global two"),
    m("p1", "bean one", undefined, "/p/bean"), m("q1", "api one", undefined, "/p/api"),
    ...Array.from({ length: 10 }, (_, i) => m(`x${i}`, `stale ${i}`)),
  ];
  const plan = planDream(mems, {
    merges: [
      { ids: ["g1", "p1"], mergedText: "global + project" }, // mixes scopes
      { ids: ["p1", "q1"], mergedText: "two projects" }, // mixes projects
      { ids: ["g1", "g2"], mergedText: "globals merged" },
      { ids: ["g2", "x0"], mergedText: "overlaps the previous group" },
      { ids: ["x1"], mergedText: "stale 1" }, // a no-op rewrite
    ],
    drops: Array.from({ length: 10 }, (_, i) => `x${i}`),
  }, "run", "2026-09-01T00:00:00.000Z");
  expect(plan.groups.filter((g) => g.text)).toEqual([{ ids: ["g1", "g2"], text: "globals merged", projectPath: undefined }]);
  expect(plan.digest.removed).toBe(3); // max(3, 20% of 14 = 2)
});

test("Undo last dream restores the run, skips a group edited since, and keeps FTS in step", async () => {
  await appendMemories(file, [...five(), m("r", "trip is next week")]);
  const chat = chatCalling([
    { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "facts a and b" } },
    { name: "merge_memories", args: { ids: ["r"], mergedText: "trip is the week of 2026-08-08" } },
    { name: "drop_memory", args: { id: "c" } },
  ]);
  const digest = (await maybeDream(deps(chat)))!;
  expect(digest).toMatchObject({ merged: 1, rewritten: 1, removed: 1 });
  expect(await dreamDetails(file, digest.runId)).toEqual([
    { before: ["fact a", "fact b"], after: "facts a and b" },
    { before: ["trip is next week"], after: "trip is the week of 2026-08-08" },
    { before: ["fact c"], after: undefined },
  ]);

  // The user edits the rewritten fact before undoing: that group keeps their edit.
  const rewritten = (await loadMemories(file)).find((x) => x.text.startsWith("trip is the week"))!;
  await updateMemory(file, rewritten.id, "trip moved to September");
  expect(await restoreDreamRun(file, digest.runId)).toEqual({ restored: 2, skipped: 1 });
  expect(await texts()).toEqual(["fact a", "fact b", "fact c", "fact d", "fact e", "trip moved to September"]);
  expect(((await getMemoryMeta(file, "lastDream")) as DreamDigest).undone).toBe(true);
  expect(await restoreDreamRun(file, digest.runId)).toEqual({ restored: 0, skipped: 0 }); // idempotent

  const fts = (q: string) => (openDb(file).prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(q) as { n: number }).n;
  expect(fts('"fact a"')).toBe(1);
  expect(fts('"facts a and b"')).toBe(0);
  expect(fts("september")).toBe(1);
  await deleteMemories(file, ["a"]);
  expect(fts('"fact a"')).toBe(0);
});
