import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotes, loadNoteHistory, saveNote, archiveNote, restoreNote, purgeNote, starNote, openQuestionCount, retrieveNoteTool, searchNotes } from "../src/note-store.js";
import { closeDb, openDb } from "../src/db.js";
import { dbFile } from "../src/config.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-notes-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const t0 = () => new Date("2026-07-04T10:00:00Z");
const t1 = () => new Date("2026-07-04T11:00:00Z");

test("saveNote creates a v1 note with the given fields", async () => {
  const slug = await saveNote(file, { title: "Flaky test strategy!", body: "## Summary\nhi\n" }, t0);
  expect(slug).toMatch(/^[0-9a-f-]{36}$/);
  const [n] = await loadNotes(file);
  expect(n!.title).toBe("Flaky test strategy!");
  expect(n!.version).toBe(1);
  expect(n!.source).toBe("chat");
  expect(n!.updated).toBe("2026-07-04T10:00:00.000Z");
});

test("loadNotes parses fields and counts open questions", async () => {
  await saveNote(file, {
    title: "T", body: "## Open questions\n- [ ] a\n- [x] done\n- [ ] b\n", project: "/p", source: "manual",
  }, t0);
  const [n] = await loadNotes(file);
  expect(n!.title).toBe("T");
  expect(n!.body.startsWith("## Open questions")).toBe(true);
  expect(n!.project).toBe("/p");
  expect(n!.source).toBe("manual");
  expect(n!.openCount).toBe(2);
});

test("two notes with the same title get distinct UUID slugs", async () => {
  const a = await saveNote(file, { title: "Same", body: "a" }, t0);
  const b = await saveNote(file, { title: "Same", body: "b" }, t0);
  expect(a).not.toBe(b);
  expect((await loadNotes(file)).map((n) => n.slug).sort()).toEqual([a, b].sort());
});

test("update in place bumps version and snapshots the prior version to notes_history", async () => {
  const slug = await saveNote(file, { title: "T", body: "v1 body" }, t0);
  await saveNote(file, { title: "T", body: "v2 body", slug }, t1);
  const [n] = await loadNotes(file);
  expect(n!.version).toBe(2);
  expect(n!.body).toBe("v2 body");
  const [hist] = await loadNoteHistory(file, slug);
  expect(hist!.version).toBe(1);
  expect(hist!.body).toBe("v1 body");
});

test("loadNotes sorts most recently updated first", async () => {
  const a = await saveNote(file, { title: "Old", body: "" }, t0);
  await saveNote(file, { title: "New", body: "" }, t1);
  expect((await loadNotes(file)).map((n) => n.title)).toEqual(["New", "Old"]);
  await saveNote(file, { title: "Old", body: "2", slug: a }, () => new Date("2026-07-04T12:00:00Z")); // creates history
  expect((await loadNotes(file)).map((n) => n.title)).toEqual(["Old", "New"]);
});

const historyCount = (): number =>
  (openDb(file).prepare("SELECT COUNT(*) AS n FROM notes_history").get() as { n: number }).n;

test("a save to a missing or archived slug throws and leaves notes_history unchanged", async () => {
  await expect(saveNote(file, { title: "T", body: "b", slug: "gone" }, t0)).rejects.toThrow(/does not exist/);
  expect(await loadNotes(file, { includeArchived: true })).toEqual([]);
  const slug = await saveNote(file, { title: "T", body: "1" }, t0);
  await saveNote(file, { title: "T", body: "2", slug }, t1);
  expect(await archiveNote(file, slug, t1)).toBe(true);
  await expect(saveNote(file, { title: "T", body: "3", slug }, t1)).rejects.toThrow(/archived/);
  expect(historyCount()).toBe(1);
  const [n] = await loadNotes(file, { includeArchived: true });
  expect([n!.body, n!.version]).toEqual(["2", 2]);
});

test("upsert creates a missing row and updates an archived one without restoring it", async () => {
  await saveNote(file, { title: "R", body: "1", slug: "routine-r" }, t0, { upsert: true });
  await archiveNote(file, "routine-r", t0);
  await saveNote(file, { title: "R", body: "2", slug: "routine-r" }, t1, { upsert: true });
  const [n] = await loadNotes(file, { includeArchived: true });
  expect([n!.body, n!.version, n!.archivedAt]).toEqual(["2", 2, "2026-07-04T10:00:00.000Z"]);
  expect(await loadNotes(file)).toEqual([]);
  // After a purge the sink starts over at v1 with empty history.
  expect(await purgeNote(file, "routine-r")).toBe(true);
  await saveNote(file, { title: "R", body: "3", slug: "routine-r" }, t1, { upsert: true });
  const [fresh] = await loadNotes(file);
  expect(fresh!.version).toBe(1);
  expect(await loadNoteHistory(file, "routine-r")).toEqual([]);
});

test("upsert v1 drops history orphaned by a pre-archive delete instead of colliding", async () => {
  openDb(file).prepare(
    "INSERT INTO notes_history (slug, version, title, body, project, updated, source) VALUES ('routine-r', 1, 'old', 'old', NULL, 'x', 'chat')",
  ).run();
  await saveNote(file, { title: "R", body: "1", slug: "routine-r" }, t0, { upsert: true });
  await saveNote(file, { title: "R", body: "2", slug: "routine-r" }, t1, { upsert: true });
  expect((await loadNoteHistory(file, "routine-r")).map((h) => h.body)).toEqual(["1"]);
});

test("an update drops legacy orphan history at/above the live version instead of colliding", async () => {
  // Pre-#304 shape: edit → delete → recreate under the same title slug left v1 history behind.
  const db = openDb(file);
  db.prepare("INSERT INTO notes (slug, title, body, project, updated, version, source) VALUES ('same', 'Same', 'new', NULL, 'x', 1, 'chat')").run();
  db.prepare("INSERT INTO notes_history (slug, version, title, body, project, updated, source) VALUES ('same', 1, 'Same', 'stale', NULL, 'x', 'chat')").run();
  await saveNote(file, { title: "Same", body: "v2", slug: "same" }, t1);
  expect((await loadNoteHistory(file, "same")).map((h) => h.body)).toEqual(["new"]);
});

test("archive and restore change neither version, history, star nor project", async () => {
  const slug = await saveNote(file, { title: "T", body: "1", project: "/p" }, t0);
  await saveNote(file, { title: "T", body: "2", project: "/p", slug }, t1);
  await starNote(file, slug, true);
  const before = (await loadNotes(file))[0]!;
  expect(await archiveNote(file, slug, t1)).toBe(true);
  expect(await archiveNote(file, slug, t1)).toBe(false);
  const archived = (await loadNotes(file, { includeArchived: true }))[0]!;
  expect(archived).toEqual({ ...before, archivedAt: "2026-07-04T11:00:00.000Z" });
  expect(await restoreNote(file, slug)).toBe(true);
  expect(await restoreNote(file, slug)).toBe(false);
  expect((await loadNotes(file))[0]).toEqual(before);
  expect(historyCount()).toBe(1);
});

test("searchNotes and loadNotes hide archived notes, even the best match", async () => {
  const best = await saveNote(file, { title: "Roadmap roadmap", body: "roadmap roadmap" }, t0);
  await saveNote(file, { title: "Other", body: "mentions roadmap once" }, t0);
  await archiveNote(file, best, t1);
  expect((await searchNotes(file, "roadmap")).map((n) => n.title)).toEqual(["Other"]);
  expect((await loadNotes(file)).map((n) => n.title)).toEqual(["Other"]);
  expect(await loadNotes(file, { includeArchived: true })).toHaveLength(2);
});

test("purgeNote refuses a live note and removes an archived one's history and FTS hits", async () => {
  const slug = await saveNote(file, { title: "Zebra", body: "1" }, t0);
  await saveNote(file, { title: "Zebra", body: "2", slug }, t1);
  expect(await purgeNote(file, slug)).toBe(false);
  expect(await purgeNote(file, "missing")).toBe(false);
  expect(await loadNotes(file)).toHaveLength(1);
  await archiveNote(file, slug, t1);
  expect(await purgeNote(file, slug)).toBe(true);
  expect(await loadNotes(file, { includeArchived: true })).toEqual([]);
  expect(await loadNoteHistory(file, slug)).toEqual([]);
  expect((openDb(file).prepare("SELECT COUNT(*) AS n FROM notes_search WHERE notes_search MATCH 'zebra'").get() as { n: number }).n).toBe(0);
});

test("loadNotes returns [] for a fresh db; archive/restore/purge are no-ops on a missing slug", async () => {
  expect(await loadNotes(file)).toEqual([]);
  expect(await archiveNote(file, "nothing")).toBe(false);
  expect(await restoreNote(file, "nothing")).toBe(false);
});

test("note fns reject traversal slugs and empty titles", async () => {
  await expect(saveNote(file, { title: "x", body: "", slug: "../evil" }, t0)).rejects.toThrow();
  await expect(saveNote(file, { title: "  ", body: "" }, t0)).rejects.toThrow();
  await expect(archiveNote(file, "a/b")).rejects.toThrow();
  await expect(restoreNote(file, "a/b")).rejects.toThrow();
  await expect(purgeNote(file, "a/b")).rejects.toThrow();
});

test("openQuestionCount matches - and * checkboxes, not checked ones", () => {
  expect(openQuestionCount("- [ ] a\n* [ ] b\n- [x] c\ntext [ ]")).toBe(2);
});

test("searchNotes matches by title or body and ranks the best match first", async () => {
  await saveNote(file, { title: "Roadmap Q3", body: "## Summary\nship the thing" }, t0);
  await saveNote(file, { title: "Grocery list", body: "eggs, milk" }, t1);
  const tool = retrieveNoteTool((q) => searchNotes(file, q));
  expect(await tool.run({ query: "roadmap" })).toContain("ship the thing");
  expect(await tool.run({ query: "eggs" })).toContain("Grocery list");
  expect(await tool.run({ query: "nonexistent" })).toContain("no saved notes matched");
  expect(await tool.run({})).toContain("error");
});

test("retrieveNoteTool matches on shared words even when the full query phrase isn't in the note", async () => {
  await saveNote(file, { title: "Roadmap Phase 1 investigation", body: "deliver() and transports" }, t0);
  const tool = retrieveNoteTool((q) => searchNotes(file, q));
  expect(await tool.run({ query: "Bean roadmap" })).toContain("Roadmap Phase 1 investigation");
});

test("legacy notes/*.md and .history/*.md are migrated in on first open", async () => {
  const notesDir = join(dir, "notes");
  await mkdir(join(notesDir, ".history"), { recursive: true });
  await writeFile(
    join(notesDir, "old-note.md"),
    "---\ntitle: Old note\nupdated: 2026-07-01T00:00:00.000Z\nversion: 2\nsource: chat\n---\ncurrent body",
  );
  await writeFile(
    join(notesDir, ".history", "old-note.v1.md"),
    "---\ntitle: Old note\nupdated: 2026-06-01T00:00:00.000Z\nversion: 1\nsource: chat\n---\nold body",
  );
  const notes = await loadNotes(file);
  expect(notes).toEqual([{
    slug: "old-note", title: "Old note", body: "current body", project: undefined,
    updated: "2026-07-01T00:00:00.000Z", version: 2, source: "chat", openCount: 0, starred: false,
  }]);
  const hist = await loadNoteHistory(file, "old-note");
  expect(hist).toHaveLength(1);
  expect(hist[0]!.body).toBe("old body");
});

test("starred notes sort first and survive an edit without bumping the version", async () => {
  await saveNote(file, { title: "Newer", body: "b" }, t1);
  const older = await saveNote(file, { title: "Older", body: "a" }, t0);
  expect((await loadNotes(file)).map((n) => n.title)).toEqual(["Newer", "Older"]);

  await starNote(file, older, true);
  const starredFirst = await loadNotes(file);
  expect(starredFirst.map((n) => n.title)).toEqual(["Older", "Newer"]);
  expect(starredFirst[0]!.starred).toBe(true);

  await saveNote(file, { title: "Older", body: "a2", slug: older }, t1);
  const afterEdit = (await loadNotes(file)).find((n) => n.slug === older)!;
  expect(afterEdit.starred).toBe(true);
  expect(afterEdit.version).toBe(2);

  await starNote(file, older, false);
  expect((await loadNotes(file)).find((n) => n.slug === older)!.starred).toBe(false);
});

test("a pre-star, pre-archive bean.db gains the starred and archived_at columns on open", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(dir, { recursive: true });
  const legacy = new DatabaseSync(file);
  // The pre-star schema verbatim, FTS and its triggers included — a fixture without them would
  // leave the index empty and make an UPDATE's FTS 'delete' report a malformed database.
  legacy.exec(
    "CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, " +
      "project TEXT, updated TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL);" +
      "CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');" +
      "CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN " +
      "INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;" +
      "INSERT INTO notes VALUES ('old', 'Old', 'body', NULL, '2026-07-01T00:00:00.000Z', 1, 'chat');",
  );
  legacy.close();

  const notes = await loadNotes(file);
  expect(notes[0]!.starred).toBe(false);
  await starNote(file, "old", true);
  expect((await loadNotes(file))[0]!.starred).toBe(true);
  // The star UPDATE ran the FTS triggers: the index must still be usable afterwards.
  expect((await searchNotes(file, "Old")).map((n) => n.slug)).toEqual(["old"]);
  expect(await archiveNote(file, "old")).toBe(true);
  expect(await loadNotes(file)).toEqual([]);
});

// The pre-#572 note search index, verbatim: trigger-maintained, external content.
const OLD_NOTES_FTS =
  "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');" +
  "CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN " +
  "INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;" +
  "CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN " +
  "INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body); END;" +
  "CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN " +
  "INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body); " +
  "INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;";
const tables = (): string[] =>
  (openDb(file).prepare("SELECT name FROM sqlite_master WHERE name IN ('notes_fts', 'notes_ai', 'notes_search')").all() as
    { name: string }[]).map((r) => r.name).sort();

test("searchNotes finds a CJK word mid-run and ranks the CJK note first", async () => {
  await saveNote(file, { title: "Health", body: "dentist appointment next week" }, t0);
  const zh = await saveNote(file, { title: "看病记录", body: "我的牙医是张医生，在中山路。" }, t0);
  expect((await searchNotes(file, "牙医"))[0]?.slug).toBe(zh);
  expect((await searchNotes(file, "张医生 dentist")).map((n) => n.slug)).toContain(zh);
  expect((await searchNotes(file, "病"))[0]?.slug).toBe(zh);
  const tool = retrieveNoteTool((q) => searchNotes(file, q));
  expect(await tool.run({ query: "牙医" })).toContain("# 看病记录");
});

test("notes_search follows edits, routine upserts, archive/restore and purge", async () => {
  const slug = await saveNote(file, { title: "旅行", body: "去东京" }, t0);
  await saveNote(file, { title: "旅行", body: "去大阪", slug }, t1);
  expect(await searchNotes(file, "东京")).toEqual([]);
  expect((await searchNotes(file, "大阪"))[0]?.slug).toBe(slug);
  await saveNote(file, { title: "Digest", body: "第一版", slug: "routine-digest" }, t0, { upsert: true });
  await saveNote(file, { title: "Digest", body: "第二版", slug: "routine-digest" }, t1, { upsert: true });
  expect((await searchNotes(file, "二版")).map((n) => n.slug)).toEqual(["routine-digest"]);
  expect(await searchNotes(file, "一版")).toEqual([]);
  await archiveNote(file, slug, t1);
  expect(await searchNotes(file, "大阪")).toEqual([]);
  await restoreNote(file, slug);
  expect((await searchNotes(file, "大阪"))[0]?.slug).toBe(slug);
  await archiveNote(file, slug, t1);
  await purgeNote(file, slug);
  expect((openDb(file).prepare("SELECT count(*) AS n FROM notes_search").get() as { n: number }).n).toBe(1);
});

test("an old-schema bean.db gets notes_search backfilled and notes_fts dropped; reopening is idempotent", async () => {
  await mkdir(dir, { recursive: true });
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, project TEXT, " +
      "updated TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL);" + OLD_NOTES_FTS +
      "INSERT INTO notes VALUES ('old', '旧笔记', '我的牙医是张医生', NULL, '2026-07-01T00:00:00.000Z', 1, 'chat');",
  );
  legacy.close();
  expect((await searchNotes(file, "牙医")).map((n) => n.slug)).toEqual(["old"]);
  expect(tables()).toEqual(["notes_search"]);
  closeDb(file);
  expect((await searchNotes(file, "牙医")).map((n) => n.slug)).toEqual(["old"]);
  expect((openDb(file).prepare("SELECT count(*) AS n FROM notes_search").get() as { n: number }).n).toBe(1);
});

test("a new bean.db indexes legacy notes/*.md imported on first open", async () => {
  await mkdir(join(dir, "notes"), { recursive: true });
  await writeFile(join(dir, "notes", "zh.md"), "---\ntitle: 看病\nversion: 1\n---\n我的牙医是张医生");
  expect((await searchNotes(file, "牙医")).map((n) => n.slug)).toEqual(["zh"]);
});

test("an older build recreating notes_fts can't break note saves once a new build reopens the db", async () => {
  const slug = await saveNote(file, { title: "Before", body: "早期" }, t0);
  closeDb(file);
  // An older build opens the same file: its SCHEMA recreates the empty external-content index
  // and triggers, then writes a note the new index never saw.
  const old = new DatabaseSync(file);
  old.exec(OLD_NOTES_FTS);
  old.exec("INSERT INTO notes (slug, title, body, updated, version, source) VALUES ('from-old', '旧版', '旧版写的笔记', '2026-07-01', 1, 'chat')");
  old.close();
  await saveNote(file, { title: "Before", body: "后来", slug }, t1);
  expect(await starNote(file, slug, true)).toBeUndefined();
  expect(tables()).toEqual(["notes_search"]);
  expect((await searchNotes(file, "旧版")).map((n) => n.slug)).toEqual(["from-old"]);
  expect((await searchNotes(file, "后来")).map((n) => n.slug)).toEqual([slug]);
});
