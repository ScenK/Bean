import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import {
  DESKTOP_CHAT_MAX_BYTES,
  deleteDesktopChat,
  getDesktopChat,
  groupDesktopChats,
  listDesktopChats,
  renameDesktopChat,
  renameDesktopChatGroup,
  saveDesktopChat,
  starDesktopChat,
} from "../src/desktop-chats.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const files: string[] = [];
const tmpDb = (): string => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-dc-")), "bean.db");
  files.push(file);
  return file;
};
afterEach(() => files.splice(0).forEach(closeDb));
const day = (d: number): Date => new Date(Date.UTC(2026, 9, d));

test("the first save stores the trimmed, capped title and returns it", () => {
  const file = tmpDb();
  expect(saveDesktopChat(file, { id: A, title: `  ${"x".repeat(100)}  `, itemsJson: "[]" }, day(1))).toBe("x".repeat(80));
  expect(getDesktopChat(file, A)?.title).toBe("x".repeat(80));
});

test("upsert keeps created_at and title, updates the rest, and returns the stored title", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "first", itemsJson: "[1]" }, day(1));
  expect(saveDesktopChat(file, { id: A, title: "second", itemsJson: "[1,2]", noteSlug: "n1" }, day(2))).toBe("first");
  expect(getDesktopChat(file, A)).toEqual({
    id: A,
    title: "first",
    createdAt: day(1).toISOString(),
    updatedAt: day(2).toISOString(),
    itemsJson: "[1,2]",
    noteSlug: "n1",
  });
});

test("lists newest first without the transcript", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" }, day(1));
  saveDesktopChat(file, { id: B, title: "b", itemsJson: "[]" }, day(3));
  expect(listDesktopChats(file, day(4))).toEqual([
    { id: B, title: "b", updatedAt: day(3).toISOString(), agents: [], starred: false, groupName: null },
    { id: A, title: "a", updatedAt: day(1).toISOString(), agents: [], starred: false, groupName: null },
  ]);
});

test("lists each thread's live agents once, ignoring Bean and unparseable rows", () => {
  const file = tmpDb();
  const items = [
    { kind: "reply", text: "hi" },
    { kind: "reply", agent: "claude", text: "a" },
    { kind: "working", agent: "codex", text: "…" },
    { kind: "reply", agent: "claude", text: "b" },
    { kind: "reply", agent: "bean", text: "c" },
    { kind: "reply", agent: "codex", text: "d" },
  ];
  saveDesktopChat(file, { id: A, title: "a", itemsJson: JSON.stringify(items) }, day(2));
  saveDesktopChat(file, { id: B, title: "b", itemsJson: "not json" }, day(1));
  expect(listDesktopChats(file, day(3)).map((c) => [c.id, [...c.agents].sort()])).toEqual([[A, ["claude", "codex"]], [B, []]]);
});

test("listing prunes only threads untouched for more than 90 days, and never delegate_runs", () => {
  const file = tmpDb();
  const now = new Date(Date.UTC(2026, 9, 29));
  const ago = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  saveDesktopChat(file, { id: A, title: "old", itemsJson: "[]" }, ago(90.01));
  saveDesktopChat(file, { id: B, title: "edge", itemsJson: "[]" }, ago(90));
  openDb(file)
    .prepare("INSERT INTO delegate_runs (started_at, surface, cli, session_id, project_path, instruction) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ago(400).toISOString(), "desktop", "claude", "s1", "/p", "x");
  expect(listDesktopChats(file, now).map((c) => c.id)).toEqual([B]);
  expect(getDesktopChat(file, A)).toBeUndefined();
  expect(openDb(file).prepare("SELECT COUNT(*) AS n FROM delegate_runs").get()).toEqual({ n: 1 });
});

test("refuses a non-UUID id or an oversized transcript", () => {
  const file = tmpDb();
  expect(() => saveDesktopChat(file, { id: "../x", title: "t", itemsJson: "[]" })).toThrow(/UUID/);
  expect(() => saveDesktopChat(file, { id: A, title: "t", itemsJson: "x".repeat(DESKTOP_CHAT_MAX_BYTES + 1) })).toThrow(/too large/);
  expect(listDesktopChats(file)).toEqual([]);
  expect(getDesktopChat(file, "../x")).toBeUndefined();
});

test("delete is idempotent", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" });
  deleteDesktopChat(file, A);
  deleteDesktopChat(file, A);
  deleteDesktopChat(file, "nope");
  expect(getDesktopChat(file, A)).toBeUndefined();
});

test("a starred thread survives the prune; starring and a fresh unstar keep updated_at; saves keep the star", () => {
  const file = tmpDb();
  const now = new Date(Date.UTC(2026, 9, 29));
  const ago = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  saveDesktopChat(file, { id: A, title: "kept", itemsJson: "[]" }, ago(100));
  saveDesktopChat(file, { id: B, title: "pruned", itemsJson: "[]" }, ago(100));
  expect(starDesktopChat(file, A, true, now)).toBe(ago(100).toISOString());
  expect(listDesktopChats(file, now)).toEqual([{ id: A, title: "kept", updatedAt: ago(100).toISOString(), agents: [], starred: true, groupName: null }]);
  saveDesktopChat(file, { id: A, title: "kept", itemsJson: "[1]" }, ago(1));
  expect(listDesktopChats(file, now)[0]!.starred).toBe(true);
  // Unstarring inside the retention window leaves the clock alone.
  expect(starDesktopChat(file, A, false, now)).toBe(ago(1).toISOString());
  expect(listDesktopChats(file, now)[0]).toMatchObject({ starred: false, updatedAt: ago(1).toISOString() });
});

test("unstarring a stale starred thread resets its clock; one exactly at the cutoff or already unstarred is untouched", () => {
  const file = tmpDb();
  const now = new Date(Date.UTC(2026, 9, 29));
  const ago = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  saveDesktopChat(file, { id: A, title: "stale", itemsJson: "[]" }, ago(120));
  starDesktopChat(file, A, true, now);
  expect(starDesktopChat(file, A, false, now)).toBe(now.toISOString());
  expect(listDesktopChats(file, now).map((c) => c.id)).toEqual([A]);

  saveDesktopChat(file, { id: B, title: "edge", itemsJson: "[]" }, ago(90));
  starDesktopChat(file, B, true, now);
  expect(starDesktopChat(file, B, false, now)).toBe(ago(90).toISOString());

  // Already unstarred and stale (not yet listed, so not yet pruned): no reset.
  const C = "33333333-3333-4333-8333-333333333333";
  saveDesktopChat(file, { id: C, title: "gone", itemsJson: "[]" }, ago(120));
  expect(starDesktopChat(file, C, false, now)).toBe(ago(120).toISOString());
});

test("starring a missing or non-UUID id returns undefined and creates no row", () => {
  const file = tmpDb();
  expect(starDesktopChat(file, A, true)).toBeUndefined();
  expect(starDesktopChat(file, "../x", true)).toBeUndefined();
  expect(openDb(file).prepare("SELECT COUNT(*) AS n FROM desktop_chats").get()).toEqual({ n: 0 });
});

test("a pre-star bean.db gains desktop_chats.starred and group_name on open", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = tmpDb();
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE desktop_chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL, items_json TEXT NOT NULL, note_slug TEXT);" +
      `INSERT INTO desktop_chats VALUES ('${A}', 'old', '${day(20).toISOString()}', '${day(20).toISOString()}', '[]', NULL);`,
  );
  legacy.close();
  expect(listDesktopChats(file, day(21))).toEqual([{ id: A, title: "old", updatedAt: day(20).toISOString(), agents: [], starred: false, groupName: null }]);
  expect(starDesktopChat(file, A, true, day(21))).toBe(day(20).toISOString());
  expect(listDesktopChats(file, day(21))[0]!.starred).toBe(true);
});

test("a rename sticks through later saves and leaves updated_at and starred alone", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "old", itemsJson: "[]" }, day(1));
  starDesktopChat(file, A, true, day(2));
  expect(renameDesktopChat(file, A, `  New\n\t ${"y".repeat(100)}  `)).toBe(`New ${"y".repeat(76)}`);
  expect(listDesktopChats(file, day(3))).toEqual([{ id: A, title: `New ${"y".repeat(76)}`, updatedAt: day(1).toISOString(), agents: [], starred: true, groupName: null }]);
  expect(saveDesktopChat(file, { id: A, title: "old", itemsJson: "[1]" }, day(4))).toBe(`New ${"y".repeat(76)}`);
  expect(getDesktopChat(file, A)?.title).toBe(`New ${"y".repeat(76)}`);
});

test("renaming refuses an empty title; a missing or non-UUID id returns undefined and creates no row", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "kept", itemsJson: "[]" }, day(1));
  expect(() => renameDesktopChat(file, A, " \n\t ")).toThrow(/empty/);
  expect(getDesktopChat(file, A)?.title).toBe("kept");
  expect(renameDesktopChat(file, B, "t")).toBeUndefined();
  expect(renameDesktopChat(file, "../x", "t")).toBeUndefined();
  expect(openDb(file).prepare("SELECT COUNT(*) AS n FROM desktop_chats").get()).toEqual({ n: 1 });
});

const C = "33333333-3333-4333-8333-333333333333";
const count = (file: string): unknown => openDb(file).prepare("SELECT COUNT(*) AS n FROM desktop_chats").get();
const groups = (file: string, now: Date): [string, boolean, string | null][] =>
  listDesktopChats(file, now).map((c) => [c.id, c.starred, c.groupName]).sort() as [string, boolean, string | null][];

test("grouping stars and groups a mix of starred and unstarred ids in one call, skipping missing ones", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" }, day(1));
  saveDesktopChat(file, { id: B, title: "b", itemsJson: "[]" }, day(2));
  starDesktopChat(file, A, true, day(3));
  expect(groupDesktopChats(file, [A, B, C, "../x"], "  Work\n stuff ").sort()).toEqual([A, B]);
  expect(groups(file, day(4))).toEqual([[A, true, "Work stuff"], [B, true, "Work stuff"]]);
  expect(count(file)).toEqual({ n: 2 });
  // updated_at untouched.
  expect(listDesktopChats(file, day(4)).map((c) => c.updatedAt).sort()).toEqual([day(1).toISOString(), day(2).toISOString()]);
  expect(groupDesktopChats(file, [C], "x")).toEqual([]);
});

test("null ungroups and keeps the star; unstarring clears the group and re-starring doesn't restore it", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" }, day(1));
  saveDesktopChat(file, { id: B, title: "b", itemsJson: "[]" }, day(1));
  groupDesktopChats(file, [A, B], "G");
  expect(groupDesktopChats(file, [A], null)).toEqual([A]);
  expect(groups(file, day(2))).toEqual([[A, true, null], [B, true, "G"]]);
  starDesktopChat(file, B, false, day(2));
  expect(groups(file, day(2))).toEqual([[A, true, null], [B, false, null]]);
  starDesktopChat(file, B, true, day(2));
  expect(groups(file, day(2))).toEqual([[A, true, null], [B, true, null]]);
  // Re-starring an already-starred grouped thread keeps its group.
  groupDesktopChats(file, [A], "G");
  starDesktopChat(file, A, true, day(2));
  expect(listDesktopChats(file, day(2)).find((c) => c.id === A)!.groupName).toBe("G");
});

test("saving a grouped thread keeps its group", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" }, day(1));
  groupDesktopChats(file, [A], "G");
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[1]" }, day(2));
  expect(listDesktopChats(file, day(3))[0]).toMatchObject({ starred: true, groupName: "G", updatedAt: day(2).toISOString() });
});

test("renaming a group moves every member; onto an existing name it merges; names are exact and case-sensitive", () => {
  const file = tmpDb();
  for (const id of [A, B, C]) saveDesktopChat(file, { id, title: id, itemsJson: "[]" }, day(1));
  groupDesktopChats(file, [A, B], "Old");
  groupDesktopChats(file, [C], "New");
  expect(renameDesktopChatGroup(file, "old", "X")).toEqual([]);
  expect(renameDesktopChatGroup(file, " Old ", "Renamed").sort()).toEqual([A, B]);
  expect(groups(file, day(2))).toEqual([[A, true, "Renamed"], [B, true, "Renamed"], [C, true, "New"]]);
  expect(renameDesktopChatGroup(file, "New", "Renamed")).toEqual([C]);
  expect(groups(file, day(2)).map((g) => g[2])).toEqual(["Renamed", "Renamed", "Renamed"]);
});

test("invalid group names are refused and change nothing", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "a", itemsJson: "[]" }, day(1));
  expect(() => groupDesktopChats(file, [A], " \n\t ")).toThrow(/empty/);
  expect(() => renameDesktopChatGroup(file, "", "x")).toThrow(/empty/);
  expect(() => renameDesktopChatGroup(file, "x", "  ")).toThrow(/empty/);
  expect(groups(file, day(2))).toEqual([[A, false, null]]);
  // Over-long names are capped like titles.
  groupDesktopChats(file, [A], "g".repeat(100));
  expect(listDesktopChats(file, day(2))[0]!.groupName).toBe("g".repeat(80));
});
