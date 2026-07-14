import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotes, loadNoteHistory, saveNote, deleteNote, openQuestionCount, retrieveNoteTool, searchNotes } from "../src/note-store.js";
import { closeDb } from "../src/db.js";
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
  expect(slug).toBe("flaky-test-strategy");
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

test("slug collisions get numeric suffixes", async () => {
  expect(await saveNote(file, { title: "Same", body: "a" }, t0)).toBe("same");
  expect(await saveNote(file, { title: "Same", body: "b" }, t0)).toBe("same-2");
  expect(await saveNote(file, { title: "Same", body: "c" }, t0)).toBe("same-3");
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
  await saveNote(file, { title: "Old", body: "2", slug: a }, t1); // creates history
  const notes = await loadNotes(file);
  expect(notes.map((n) => n.slug)).toEqual(["new", "old"]);
});

test("update with a stale slug (row gone) recreates as v1", async () => {
  await saveNote(file, { title: "T", body: "b", slug: "gone" }, t0);
  const [n] = await loadNotes(file);
  expect(n!.slug).toBe("gone");
  expect(n!.version).toBe(1);
});

test("loadNotes returns [] for a fresh db; deleteNote is a no-op on a missing slug", async () => {
  expect(await loadNotes(file)).toEqual([]);
  await expect(deleteNote(file, "nothing")).resolves.toBeUndefined();
});

test("saveNote/deleteNote reject traversal slugs and empty titles", async () => {
  await expect(saveNote(file, { title: "x", body: "", slug: "../evil" }, t0)).rejects.toThrow();
  await expect(saveNote(file, { title: "  ", body: "" }, t0)).rejects.toThrow();
  await expect(deleteNote(file, "a/b")).rejects.toThrow();
});

test("deleteNote removes the note but keeps history", async () => {
  const slug = await saveNote(file, { title: "T", body: "1" }, t0);
  await saveNote(file, { title: "T", body: "2", slug }, t1);
  await deleteNote(file, slug);
  expect(await loadNotes(file)).toEqual([]);
  expect((await loadNoteHistory(file, slug)).map((n) => n.version)).toEqual([1]);
});

test("openQuestionCount matches - and * checkboxes, not checked ones", () => {
  expect(openQuestionCount("- [ ] a\n* [ ] b\n- [x] c\ntext [ ]")).toBe(2);
});

test("weird title slugifies to 'note'", async () => {
  expect(await saveNote(file, { title: "!!!", body: "" }, t0)).toBe("note");
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
    updated: "2026-07-01T00:00:00.000Z", version: 2, source: "chat", openCount: 0,
  }]);
  const hist = await loadNoteHistory(file, "old-note");
  expect(hist).toHaveLength(1);
  expect(hist[0]!.body).toBe("old body");
});
