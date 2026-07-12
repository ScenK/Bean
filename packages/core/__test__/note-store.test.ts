import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotes, saveNote, deleteNote, openQuestionCount, retrieveNoteTool } from "../src/note-store.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-notes-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const t0 = () => new Date("2026-07-04T10:00:00Z");
const t1 = () => new Date("2026-07-04T11:00:00Z");

test("saveNote creates a v1 file with frontmatter and slug from title", async () => {
  const slug = await saveNote(dir, { title: "Flaky test strategy!", body: "## Summary\nhi\n" }, t0);
  expect(slug).toBe("flaky-test-strategy");
  const raw = await readFile(join(dir, "flaky-test-strategy.md"), "utf8");
  expect(raw).toContain("title: Flaky test strategy!");
  expect(raw).toContain("version: 1");
  expect(raw).toContain("source: chat");
  expect(raw).toContain("updated: 2026-07-04T10:00:00.000Z");
});

test("loadNotes parses fields, strips frontmatter from body, counts open questions", async () => {
  await saveNote(dir, {
    title: "T", body: "## Open questions\n- [ ] a\n- [x] done\n- [ ] b\n", project: "/p", source: "manual",
  }, t0);
  const [n] = await loadNotes(dir);
  expect(n!.title).toBe("T");
  expect(n!.body.startsWith("## Open questions")).toBe(true);
  expect(n!.project).toBe("/p");
  expect(n!.source).toBe("manual");
  expect(n!.openCount).toBe(2);
});

test("slug collisions get numeric suffixes", async () => {
  expect(await saveNote(dir, { title: "Same", body: "a" }, t0)).toBe("same");
  expect(await saveNote(dir, { title: "Same", body: "b" }, t0)).toBe("same-2");
  expect(await saveNote(dir, { title: "Same", body: "c" }, t0)).toBe("same-3");
});

test("update in place bumps version and snapshots the prior file to .history", async () => {
  const slug = await saveNote(dir, { title: "T", body: "v1 body" }, t0);
  await saveNote(dir, { title: "T", body: "v2 body", slug }, t1);
  const [n] = await loadNotes(dir);
  expect(n!.version).toBe(2);
  expect(n!.body).toBe("v2 body");
  const hist = await readFile(join(dir, ".history", `${slug}.v1.md`), "utf8");
  expect(hist).toContain("v1 body");
});

test("loadNotes sorts most recently updated first and ignores .history", async () => {
  const a = await saveNote(dir, { title: "Old", body: "" }, t0);
  await saveNote(dir, { title: "New", body: "" }, t1);
  await saveNote(dir, { title: "Old", body: "2", slug: a }, t1); // creates .history
  const notes = await loadNotes(dir);
  expect(notes.map((n) => n.slug)).toEqual(["new", "old"]);
});

test("update with a stale slug (file deleted) recreates as v1", async () => {
  await saveNote(dir, { title: "T", body: "b", slug: "gone" }, t0);
  const [n] = await loadNotes(dir);
  expect(n!.slug).toBe("gone");
  expect(n!.version).toBe(1);
});

test("loadNotes returns [] for a missing dir; deleteNote is a no-op on missing file", async () => {
  expect(await loadNotes(join(dir, "nope"))).toEqual([]);
  await expect(deleteNote(dir, "nothing")).resolves.toBeUndefined();
});

test("saveNote/deleteNote reject traversal slugs and empty titles", async () => {
  await expect(saveNote(dir, { title: "x", body: "", slug: "../evil" }, t0)).rejects.toThrow();
  await expect(saveNote(dir, { title: "  ", body: "" }, t0)).rejects.toThrow();
  await expect(deleteNote(dir, "a/b")).rejects.toThrow();
});

test("deleteNote removes the note but keeps history", async () => {
  const slug = await saveNote(dir, { title: "T", body: "1" }, t0);
  await saveNote(dir, { title: "T", body: "2", slug }, t1);
  await deleteNote(dir, slug);
  expect(await loadNotes(dir)).toEqual([]);
  expect(await readdir(join(dir, ".history"))).toEqual([`${slug}.v1.md`]);
});

test("openQuestionCount matches - and * checkboxes, not checked ones", () => {
  expect(openQuestionCount("- [ ] a\n* [ ] b\n- [x] c\ntext [ ]")).toBe(2);
});

test("titleless file falls back to slug; weird title slugifies to 'note'", async () => {
  await writeFile(join(dir, "raw.md"), "no frontmatter here");
  const [n] = await loadNotes(dir);
  expect(n!.title).toBe("raw");
  expect(await saveNote(dir, { title: "!!!", body: "" }, t0)).toBe("note");
});

test("retrieveNoteTool matches by title or body and returns the note's content", async () => {
  await saveNote(dir, { title: "Roadmap Q3", body: "## Summary\nship the thing" }, t0);
  await saveNote(dir, { title: "Grocery list", body: "eggs, milk" }, t1);
  const tool = retrieveNoteTool(() => loadNotes(dir));
  expect(await tool.run({ query: "roadmap" })).toContain("ship the thing");
  expect(await tool.run({ query: "eggs" })).toContain("Grocery list");
  expect(await tool.run({ query: "nonexistent" })).toContain("no saved notes matched");
  expect(await tool.run({})).toContain("error");
});
