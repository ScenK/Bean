import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadMemories, appendMemories, updateMemory, deleteMemories, shareMemory, selectRelevantMemories } from "../src/memory/store.js";
import { makeMemoryTools } from "../src/memory/tools.js";
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
  await appendMemories(nested, memories);
  expect(await loadMemories(nested)).toEqual(memories);
  closeDb(nested);
});

test("appendMemories adds without touching existing rows", async () => {
  await appendMemories(file, [m("a", "one")]);
  await appendMemories(file, [m("b", "two")]);
  expect(await loadMemories(file)).toEqual([m("a", "one"), m("b", "two")]);
});

test("two concurrent appendMemories calls both survive (the race a list+replace loses)", async () => {
  await appendMemories(file, [m("base", "existing fact")]);
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

test("a Persona edit racing a concurrent appendMemories loses neither write", async () => {
  await appendMemories(file, [m("a", "old text")]);
  await Promise.all([updateMemory(file, "a", "edited text"), appendMemories(file, [m("b", "auto-remembered")])]);
  expect(await loadMemories(file)).toEqual([m("a", "edited text"), m("b", "auto-remembered")]);
});

test("deleteMemories removes exactly those ids, is idempotent, and keeps FTS in step", async () => {
  await appendMemories(file, [m("a", "one"), m("b", "two"), m("c", "three")]);
  expect(await deleteMemories(file, ["a", "c"])).toBe(2);
  expect(await deleteMemories(file, ["a", "c"])).toBe(0);
  expect(await deleteMemories(file, [])).toBe(0);
  expect(await loadMemories(file)).toEqual([m("b", "two")]);
});

test("remember/forget_memory tools save only quoted facts and forget only known ids", async () => {
  await appendMemories(file, [m("keep", "uses vitest")]);
  const t = makeMemoryTools({
    append: (a) => appendMemories(file, a),
    forget: (ids) => deleteMemories(file, ids),
    memories: await loadMemories(file),
    projects: [],
    latestUserText: "remember that I prefer tabs over spaces, and forget that I use vitest",
  });
  const [remember, forget] = t.tools;
  expect(await remember!.run({ text: "Prefers tabs over spaces", quote: "I prefer tabs over spaces" })).toMatch(/^Remembered/);
  expect(await remember!.run({ text: "Prefers email for passwords", quote: "passwords" })).toMatch(/^error/);
  expect(await remember!.run({ text: "prefers tabs over spaces", quote: "I prefer tabs over spaces" })).toBe("Already remembered.");
  expect(t.remembered.map((x) => x.text)).toEqual(["Prefers tabs over spaces"]);
  expect(await forget!.run({ ids: ["nope"] })).toMatch(/^error/);
  expect(await forget!.run({ ids: ["keep"] })).toBe("Forgot 1 fact(s).");
  expect((await loadMemories(file)).map((x) => x.text)).toEqual(["Prefers tabs over spaces"]);
});

test("a private remember tells the model about the Share with everyone button; a shared one doesn't", async () => {
  const tools = (subjectId?: string) => makeMemoryTools({
    append: (a) => appendMemories(file, a), forget: async () => 0, memories: [], projects: [],
    latestUserText: "remember that I prefer tabs", ...(subjectId ? { subjectId } : {}),
  }).tools[0]!;
  const args = { text: "Prefers tabs", quote: "I prefer tabs" };
  expect(await tools("mia").run(args)).toContain("Saved privately. If this updates a household fact shown in what you remember, say so and mention the Share with everyone button on the receipt.");
  expect(await tools().run(args)).toBe("Remembered: Prefers tabs");
});

test("memory tools are only offered when the typed message asks to remember or forget", () => {
  const offered = (text: string) => makeMemoryTools({
    append: async () => {}, forget: async () => 0, memories: [], projects: [], latestUserText: text,
  }).tools.map((t) => t.spec.name);
  expect(offered("summarize this page")).toEqual([]);
  expect(offered("remember that I use tabs")).toEqual(["remember"]);
  expect(offered("please keep in mind I'm on a Mac")).toEqual(["remember"]);
  expect(offered("forget that I like tabs")).toEqual(["forget_memory"]);
  expect(offered("I can't remember the command")).toEqual([]);
  expect(offered("Forget the last draft and try again")).toEqual([]);
  expect(offered("review the delete API docs")).toEqual([]);
  expect(offered("note that the build is slow")).toEqual([]);
  expect(offered("please delete that memory about tabs")).toEqual(["forget_memory"]);
  expect(offered("Remember, I use zed")).toEqual(["remember"]);
  expect(offered("please remember: the wifi is bean")).toEqual(["remember"]);
  expect(offered("don't forget that I use zed")).toEqual(["remember"]);
  expect(offered("记住，我喜欢用pnpm")).toEqual(["remember"]);
  expect(offered("기억해: 저는 서울에 살아요")).toEqual(["remember"]);
  expect(offered("覚えて、私はVimを使っています")).toEqual(["remember"]);
  expect(offered("I can't remember, sorry")).toEqual([]);
});

test("a pre-scoping bean.db gains subject_id on open; old rows read as shared everywhere", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, project_path TEXT, created_at TEXT NOT NULL);" +
      "CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='rowid');" +
      "CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text); END;" +
      "INSERT INTO memories VALUES ('a', 'prefers tabs', NULL, '2026-07-01T00:00:00.000Z');",
  );
  legacy.close();

  const all = await loadMemories(file);
  expect(all).toEqual([{ id: "a", text: "prefers tabs", createdAt: "2026-07-01T00:00:00.000Z" }]);
  // Desktop recall (no scope), a channel/routine (shared only) and a DM all see the old row.
  expect(await loadMemories(file, null)).toEqual(all);
  expect(await loadMemories(file, "mia")).toEqual(all);
  // A member can't delete it; the owner (no subject) can.
  expect(await deleteMemories(file, ["a"], "mia")).toBe(0);
  expect(await deleteMemories(file, ["a"])).toBe(1);
});

test("scoped recall and delete: private rows reach only their speaker", async () => {
  await appendMemories(file, [m("s", "household wifi is bean"), { ...m("p", "mia likes oat milk"), subjectId: "mia" }]);
  expect((await loadMemories(file, "mia")).map((x) => x.id).sort()).toEqual(["p", "s"]);
  expect((await loadMemories(file, "max")).map((x) => x.id)).toEqual(["s"]);
  expect((await loadMemories(file, null)).map((x) => x.id)).toEqual(["s"]);
  expect((await loadMemories(file)).find((x) => x.id === "p")?.subjectId).toBe("mia");
  expect(await deleteMemories(file, ["p", "s"], "max")).toBe(0);
  expect(await deleteMemories(file, ["p", "s"], "mia")).toBe(1);
  expect((await loadMemories(file)).map((x) => x.id)).toEqual(["s"]);
});

test("saveScope: DM private, channel shared; overrides only when unambiguous", async () => {
  const { saveScope } = await import("../src/memory/tools.js");
  expect(saveScope("remember that I prefer espresso", true)).toBe("private");
  expect(saveScope("remember that I prefer espresso", false)).toBe("shared");
  expect(saveScope("remember that I prefer espresso for everyone", true)).toBe("shared");
  expect(saveScope("remember that I prefer espresso; this is not for everyone", true)).toBe("private");
  expect(saveScope("remember that I prefer espresso, just for me", false)).toBe("private");
  expect(saveScope("remember that I want mint tea, save it for everyone", true)).toBe("shared");
  expect(saveScope("remember that I prefer espresso but don't share it for everyone", true)).toBe("private");
  // A negation elsewhere in a correction doesn't void the override; one next to the scope phrase does.
  expect(saveScope("it's not Kim anymore, remember for everyone that Leo coaches", true)).toBe("shared");
  expect(saveScope("no, Leo coaches now, not Kim. Remember that for the family", true)).toBe("shared");
  expect(saveScope("remember that Leo coaches, not for everyone", true)).toBe("private");
  expect(saveScope("remember that Leo coaches; it isn’t for the family", true)).toBe("private");
  expect(saveScope("remember that Leo coaches. No, not for everyone!", true)).toBe("private");
  expect(saveScope('remember that Leo coaches; this is not "for everyone"', true)).toBe("private");
  expect(saveScope("remember that Leo coaches, not (for the family)", true)).toBe("private");
  expect(saveScope("remember that Leo coaches; it isn’t “for everyone”", true)).toBe("private");
  expect(saveScope("it's not Kim, remember that Leo coaches just for me, not for everyone", false)).toBe("private");
  expect(saveScope("just for me … remember that Leo coaches for everyone", false)).toBe("private");
});

test("shareMemory: only the author flips their private row to shared, text/project/date unchanged", async () => {
  await appendMemories(file, [
    { id: "mias", text: "wifi is now bean2", projectPath: "/p/home", createdAt: "2026-02-01T00:00:00.000Z", subjectId: "mia" },
    { id: "shared", text: "wifi is bean", createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  expect(await shareMemory(file, "mias", "max")).toBe(0); // another member
  expect(await shareMemory(file, "mias", "u1")).toBe(0); // the owner gets no bypass
  expect(await shareMemory(file, "mias", "")).toBe(0); // empty actor
  expect(await shareMemory(file, "shared", "mia")).toBe(0); // already shared
  expect(await loadMemories(file, null)).toHaveLength(1);
  // Two concurrent taps: exactly one flips the row.
  const taps = await Promise.all([shareMemory(file, "mias", "mia"), shareMemory(file, "mias", "mia")]);
  expect(taps.reduce((a, b) => a + b, 0)).toBe(1);
  const row = (await loadMemories(file, null)).find((m) => m.id === "mias");
  expect(row).toEqual({ id: "mias", text: "wifi is now bean2", projectPath: "/p/home", createdAt: "2026-02-01T00:00:00.000Z" });
  await deleteMemories(file, ["mias"]);
  expect(await shareMemory(file, "mias", "mia")).toBe(0); // deleted row
});
