import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import {
  DESKTOP_CHAT_MAX_BYTES,
  deleteDesktopChat,
  getDesktopChat,
  listDesktopChats,
  saveDesktopChat,
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

test("upsert keeps created_at, updates the rest, and trims the title", () => {
  const file = tmpDb();
  saveDesktopChat(file, { id: A, title: "first", itemsJson: "[1]" }, day(1));
  saveDesktopChat(file, { id: A, title: `  ${"x".repeat(100)}  `, itemsJson: "[1,2]", noteSlug: "n1" }, day(2));
  expect(getDesktopChat(file, A)).toEqual({
    id: A,
    title: "x".repeat(80),
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
    { id: B, title: "b", updatedAt: day(3).toISOString(), agents: [] },
    { id: A, title: "a", updatedAt: day(1).toISOString(), agents: [] },
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
