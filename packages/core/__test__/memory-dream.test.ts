import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.js";
import { dbFile } from "../src/config.js";
import {
  appendMemories, claimDreamLease, deleteMemories, dreamDetails, getMemoryMeta, loadMemories, restoreDreamRun,
  updateMemory, updateMemoryCategory, type DreamDigest,
} from "../src/memory/store.js";
import { maybeDream, planDream } from "../src/memory/dream.js";
import { speakerLabel } from "../src/memory/memory.js";
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

test("planDream never merges across speaker prefixes, and a merge keeps its prefix", () => {
  const long = speakerLabel("A".repeat(60));
  const mems = [m("l1", `${long}: Prefers coffee`), m("o", "Prefers tea"), m("a1", "Mia: Prefers tea"), m("a2", "Mia: Drinks oolong"), m("b1", "Gus: Prefers tea")];
  const plan = planDream(mems, {
    merges: [
      { ids: ["o", "a1"], mergedText: "Prefers tea" }, // owner + Mia
      { ids: ["a1", "b1"], mergedText: "Mia: Prefers tea" }, // two speakers
      { ids: ["a2"], mergedText: "Drinks oolong" }, // rewrite drops the prefix
      { ids: ["a1", "a2"], mergedText: "Mia: Prefers tea, mostly oolong" },
      { ids: ["o", "l1"], mergedText: "Prefers coffee" }, // a long name capture capped to the parsed width
    ],
    drops: [],
  }, "run", "2026-09-01T00:00:00.000Z");
  expect(plan.groups).toEqual([{ ids: ["a1", "a2"], text: "Mia: Prefers tea, mostly oolong", projectPath: undefined }]);
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

test("the pending auto-save batch is left out of the run", async () => {
  await appendMemories(file, five());
  let seen = "";
  const chat: ConverseDeps["chat"] = async ({ messages }) => { seen = String(messages[1]!.content); return { content: "", toolCalls: [] }; };
  let pending = ["a"];
  const deferred = maybeDream({ ...deps(chat), exclude: () => pending });
  pending = ["e"]; // a later close replaced the pending batch before the snapshot
  await deferred;
  expect(seen).toContain("fact a");
  expect(seen).not.toContain("fact e"); // read at snapshot time, not when the run was triggered
});

test("a model outage doesn't advance the watermark, so the next close retries", async () => {
  await appendMemories(file, five());
  expect(await maybeDream(deps(async () => { throw new Error("503"); }))).toBeUndefined();
  expect(await getMemoryMeta(file, "lastDreamAt")).toBeUndefined();
  expect((await maybeDream(deps(chatCalling([{ name: "drop_memory", args: { id: "a" } }]))))?.removed).toBe(1);
});

test("an old digest is dropped with its pruned history, and only the current last dream is undoable", async () => {
  await appendMemories(file, five());
  const first = (await maybeDream(deps(chatCalling([{ name: "drop_memory", args: { id: "a" } }]))))!;
  await appendMemories(file, ["f", "g", "h", "i", "j"].map((id) => m(id, `fact ${id}`, new Date(T0 + 1000).toISOString())));
  // 31 days later a no-change run prunes the first run's history — its Undo must go too.
  expect(await maybeDream(deps(chatCalling([]), T0 + 31 * DAY))).toBeUndefined();
  expect(await getMemoryMeta(file, "lastDream")).toBeUndefined();
  expect(await restoreDreamRun(file, first.runId)).toEqual({ restored: 0, skipped: 0 });
  expect(await texts()).not.toContain("fact a");
});

test("planDream refuses merges across category or source", () => {
  const mems: Memory[] = [
    { ...m("y1", "likes tea"), category: "You" }, { ...m("y2", "likes green tea"), category: "You" },
    { ...m("w1", "likes oolong"), category: "Work" }, m("u1", "drinks tea"),
    { ...m("s1", "Mia: tea"), sourceId: "discord:1" }, { ...m("s2", "Mia: oolong"), sourceId: "discord:2" },
  ];
  const plan = planDream(mems, {
    merges: [
      { ids: ["y1", "w1"], mergedText: "likes tea and oolong" }, // two categories
      { ids: ["y2", "u1"], mergedText: "drinks green tea" }, // category + uncategorized
      { ids: ["s1", "s2"], mergedText: "Mia: tea, oolong" }, // two sources
      { ids: ["y1", "y2"], mergedText: "likes tea, green mostly" },
    ],
    drops: [],
  }, "run", "2026-09-01T00:00:00.000Z");
  expect(plan.groups).toEqual([{ ids: ["y1", "y2"], text: "likes tea, green mostly", category: "You" }]);
});

test("a dream merge keeps category/source, undo restores them, and a recategorize since survives undo", async () => {
  const src = { sourceId: "discord:42", sourceTitle: "#general" };
  await appendMemories(file, [
    { ...m("a", "Mia: fact a"), ...src, category: "Team" }, { ...m("b", "Mia: fact b"), ...src, category: "Team" },
    { ...m("c", "fact c"), category: "You" }, { ...m("d", "fact d"), category: "You" }, m("e", "fact e"),
  ]);
  const chat = chatCalling([
    { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "Mia: facts a and b" } },
    { name: "merge_memories", args: { ids: ["c", "d"], mergedText: "facts c and d" } },
  ]);
  const digest = (await maybeDream(deps(chat)))!;
  const after = await loadMemories(file);
  expect(after.find((x) => x.text === "Mia: facts a and b")).toMatchObject({ category: "Team", ...src });
  const cd = after.find((x) => x.text === "facts c and d")!;
  expect(cd.category).toBe("You");

  await updateMemoryCategory(file, cd.id, "Hobbies"); // the user's newer decision
  expect(await restoreDreamRun(file, digest.runId)).toEqual({ restored: 1, skipped: 1 });
  const rows = new Map((await loadMemories(file)).map((x) => [x.id, x]));
  expect(rows.get("a")).toEqual({ ...m("a", "Mia: fact a"), ...src, category: "Team" });
  expect(rows.get("b")).toEqual({ ...m("b", "Mia: fact b"), ...src, category: "Team" });
  expect(rows.get(cd.id)?.category).toBe("Hobbies");
  expect(rows.has("c")).toBe(false);
});

test("a row recategorized mid-dream aborts the run", async () => {
  await appendMemories(file, five());
  const chat = chatCalling(
    [{ name: "merge_memories", args: { ids: ["a", "b"], mergedText: "facts a and b" } }],
    () => updateMemoryCategory(file, "a", "You"),
  );
  expect(await maybeDream(deps(chat))).toBeUndefined();
  expect(await texts()).toEqual(["fact a", "fact b", "fact c", "fact d", "fact e"]);
});

test("a dream reviews every shared row, 150 per model call, as one plan", async () => {
  await appendMemories(file, Array.from({ length: 320 }, (_, i) => m(`r${i}`, `fact ${i}`)));
  const seen: number[] = [];
  let clock = T0;
  const chat: ConverseDeps["chat"] = async ({ messages }) => {
    clock += 6 * 60_000; // three calls outlast one 10-min lease: each chunk must renew it
    const body = String(messages[1]!.content);
    expect(body.startsWith("Today is 2026-09-01.")).toBe(true);
    seen.push(body.split("\n").filter((l) => l.startsWith("- [")).length);
    return { content: "", toolCalls: body.includes("[r319]") ? [{ name: "drop_memory", args: { id: "r319" } }] : [] };
  };
  expect(await maybeDream({ ...deps(chat), now: () => new Date(clock) })).toMatchObject({ removed: 1 });
  expect(seen).toEqual([150, 150, 20]);
  expect(await loadMemories(file)).toHaveLength(319);
});

test("planDream merges only equal or empty contexts, keeps the label, and never folds it into the text", () => {
  const mems: Memory[] = [
    { ...m("a", "Only in staging"), context: "where the login bug shows up" },
    { ...m("b", "Happens after deploys"), context: "where the login bug shows up" },
    { ...m("c", "Kind of want it blue"), context: "the new logo color" },
    { ...m("d", "Only on Fridays"), context: "the backup schedule" },
    m("e", "Prefers dark mode"),
    { ...m("f", "Prefers dark themes"), context: "editor theme" },
    { ...m("g", "Only weekdays"), context: "the backup schedule" },
  ];
  const plan = planDream(mems, {
    merges: [
      { ids: ["c", "d"], mergedText: "Only blue, on Fridays" }, // two different labels
      { ids: ["a", "b"], mergedText: "Login bug only in staging, after deploys" }, // borrows "login"
      { ids: ["e", "f"], mergedText: "Prefers dark mode and dark themes" }, // label + unlabeled: ok
      { ids: ["g"], mergedText: "Backup only on weekdays" }, // rewrite that borrows "backup"
    ],
    drops: [],
  }, "run", "2026-09-01T00:00:00.000Z");
  expect(plan.groups).toEqual([{ ids: ["e", "f"], text: "Prefers dark mode and dark themes", context: "editor theme" }]);
});

test("planDream refuses merged text that borrows a short or framing label word", () => {
  const mems: Memory[] = [
    { ...m("a", "Only in staging"), context: "API" }, { ...m("b", "Happens after deploys"), context: "API" },
    { ...m("c", "Only on Fridays"), context: "user backups" }, { ...m("d", "Also on Mondays"), context: "user backups" },
    { ...m("e", "Only in staging"), context: "API" }, { ...m("f", "Only in staging cluster"), context: "API" },
  ];
  const plan = planDream(mems, {
    merges: [
      { ids: ["a", "b"], mergedText: "API only in staging after deploys" },
      { ids: ["c", "d"], mergedText: "User only on Fridays and Mondays" },
      { ids: ["e", "f"], mergedText: "Only in the staging cluster" },
    ],
    drops: [],
  }, "run", "2026-09-01T00:00:00.000Z");
  expect(plan.groups).toEqual([{ ids: ["e", "f"], text: "Only in the staging cluster", context: "API" }]);
});

test("a dream merge and its undo keep context", async () => {
  const ctx = "where the login bug shows up";
  await appendMemories(file, [
    { ...m("a", "Only in staging"), context: ctx }, { ...m("b", "Only in staging cluster"), context: ctx },
    m("c", "fact c"), m("d", "fact d"), m("e", "fact e"),
  ]);
  const digest = (await maybeDream(deps(chatCalling([
    { name: "merge_memories", args: { ids: ["a", "b"], mergedText: "Only in the staging cluster" } },
  ]))))!;
  expect((await loadMemories(file)).find((x) => x.text === "Only in the staging cluster")?.context).toBe(ctx);
  expect(await restoreDreamRun(file, digest.runId)).toEqual({ restored: 1, skipped: 0 });
  const rows = new Map((await loadMemories(file)).map((x) => [x.id, x]));
  expect(rows.get("a")).toEqual({ ...m("a", "Only in staging"), context: ctx });
  expect(rows.get("b")?.context).toBe(ctx);
});
