import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/chatops/conversation.js";
import { ConversationCatalog, listChatopsConversations } from "../src/chatops/catalog.js";
import { closeDb, openDb } from "../src/db.js";
import { dbFile } from "../src/config.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-conversation-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

test("returns empty history for an unknown conversation", () => {
  expect(new ConversationStore(file).history("c1")).toEqual([]);
});

test("appends turns per conversation independently", () => {
  const s = new ConversationStore(file);
  s.append("c1", { role: "user", content: "hi" });
  s.append("c1", { role: "assistant", content: "hello" });
  s.append("c2", { role: "user", content: "other" });
  expect(s.history("c1")).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  expect(s.history("c2")).toHaveLength(1);
});

test("history persists across a fresh ConversationStore instance on the same db", () => {
  new ConversationStore(file).append("c1", { role: "user", content: "hi" });
  expect(new ConversationStore(file).history("c1")).toEqual([{ role: "user", content: "hi" }]);
});

test("turnCount and oldest back the compaction pass", () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < 45; i++) s.append("c1", { role: "user", content: `m${i}` });
  expect(s.turnCount("c1")).toBe(45);
  const oldest3 = s.oldest("c1", 3);
  expect(oldest3.map((t) => t.content)).toEqual(["m0", "m1", "m2"]);
});

test("clear() wipes one conversation's history without touching others", () => {
  const s = new ConversationStore(file);
  s.append("c1", { role: "user", content: "hi" });
  s.append("c1", { role: "assistant", content: "hello" });
  s.append("c2", { role: "user", content: "other" });
  s.clear("c1");
  expect(s.history("c1")).toEqual([]);
  expect(s.history("c2")).toEqual([{ role: "user", content: "other" }]);
});

test("ambient cutoff defaults to 0 and survives a fresh store on the same db", () => {
  expect(new ConversationStore(file).ambientCutoff("c1")).toBe(0);
  new ConversationStore(file).setAmbientCutoff("c1", 12345);
  expect(new ConversationStore(file).ambientCutoff("c1")).toBe(12345);
  expect(new ConversationStore(file).ambientCutoff("c2")).toBe(0);
});

test("setAmbientCutoff overwrites the previous value for that conversation", () => {
  const s = new ConversationStore(file);
  s.setAmbientCutoff("c1", 100);
  s.setAmbientCutoff("c1", 200);
  expect(s.ambientCutoff("c1")).toBe(200);
});

test("replaceOldest collapses the oldest n turns into one summary turn, keeping the rest", () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < 10; i++) s.append("c1", { role: "user", content: `m${i}` });
  s.replaceOldest("c1", 6, { role: "system", content: "summary of m0..m5" });
  const h = s.history("c1");
  expect(h.map((t) => t.content)).toEqual(["summary of m0..m5", "m6", "m7", "m8", "m9"]);
  expect(h[0]?.role).toBe("system");
});

test("onChange fires once per append, replaceOldest and clear", () => {
  const changed: string[] = [];
  const s = new ConversationStore(file, { onChange: (id) => changed.push(id) });
  s.append("c1", { role: "user", content: "a" });
  s.append("c1", { role: "user", content: "b" });
  s.replaceOldest("c1", 1, { role: "assistant", content: "summary" });
  s.clear("c1");
  expect(changed).toEqual(["c1", "c1", "c1", "c1"]);
});

test("a throwing onChange doesn't fail the write", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const s = new ConversationStore(file, { onChange: () => { throw new Error("boom"); } });
  s.append("c1", { role: "user", content: "a" });
  expect(s.history("c1")).toHaveLength(1);
  warn.mockRestore();
});

const owner = [{ surface: "discord" as const, ownerId: "u1" }];

test("clear (/new) of a catalogued conversation archives its turns and drops sessions and the live binding", () => {
  const changed: string[] = [];
  const s = new ConversationStore(file, { onChange: (id) => changed.push(id) });
  const catalog = new ConversationCatalog(file, "discord", () => new Date("2026-10-01T00:00:00.000Z"));
  s.append("c1", { role: "user", content: "a" });
  s.append("c1", { role: "assistant", content: "b" });
  s.setThreadSession("c1", "claude", "sess-d");
  catalog.upsert({ conversationId: "c1", place: { kind: "thread", title: "bugs" }, ownerId: "u1", live: { cli: "claude", sessionId: "sess-l" } });
  changed.length = 0;
  const archiveId = s.clear("c1");
  expect(archiveId).toMatch(/^c1~[0-9a-f-]{36}$/);
  expect(changed).toEqual(["c1"]);
  expect(s.history("c1")).toEqual([]);
  expect(s.history(archiveId!)).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  expect(s.threadSession("c1", "claude")).toBeUndefined();
  const rows = listChatopsConversations(file, owner);
  expect(rows).toHaveLength(2);
  const [fresh, archive] = rows;
  expect(fresh).toMatchObject({ conversationId: "c1", title: "bugs" });
  expect(fresh?.liveSessionId).toBeUndefined();
  expect(fresh?.liveCli).toBeUndefined();
  expect(fresh?.archivedFrom).toBeUndefined();
  expect(archive).toEqual({
    conversationId: archiveId, surface: "discord", kind: "thread", title: "bugs", ownerId: "u1",
    liveCli: "claude", updatedAt: "2026-10-01T00:00:00.000Z", archivedFrom: "c1",
  });
  expect(catalog.get(archiveId!)?.archivedFrom).toBe("c1");
});

test("clear (/new) hard-deletes an uncatalogued, empty or just-reset conversation — no archive", () => {
  const s = new ConversationStore(file);
  const catalog = new ConversationCatalog(file, "discord");
  s.append("member-dm", { role: "user", content: "a" });
  expect(s.clear("member-dm")).toBeUndefined();
  expect(s.history("member-dm")).toEqual([]);
  catalog.upsert({ conversationId: "c1", place: { kind: "dm", title: "DM" }, ownerId: "u1" });
  expect(s.clear("c1")).toBeUndefined();
  s.append("c1", { role: "user", content: "a" });
  expect(s.clear("c1")).toBeDefined();
  expect(s.clear("c1")).toBeUndefined();
  expect(listChatopsConversations(file, owner)).toHaveLength(2);
});

test("a failed clear (/new) leaves turns, sessions and bindings unchanged", () => {
  const s = new ConversationStore(file);
  const catalog = new ConversationCatalog(file, "discord");
  s.append("c1", { role: "user", content: "a" });
  s.setThreadSession("c1", "claude", "sess-d");
  catalog.upsert({ conversationId: "c1", place: { kind: "thread", title: "bugs" }, ownerId: "u1", live: { cli: "claude", sessionId: "sess-l" } });
  // Fails the last step (the live unbind), after the turns moved and the archive row was written.
  openDb(file).exec("CREATE TRIGGER fail_unbind BEFORE UPDATE ON chatops_conversations BEGIN SELECT RAISE(ABORT, 'boom'); END");
  expect(() => s.clear("c1")).toThrow(/boom/);
  openDb(file).exec("DROP TRIGGER fail_unbind");
  expect(s.history("c1")).toEqual([{ role: "user", content: "a" }]);
  expect(s.threadSession("c1", "claude")).toBe("sess-d");
  expect(listChatopsConversations(file, owner)).toEqual([expect.objectContaining({ conversationId: "c1", liveSessionId: "sess-l" })]);
});

test("listing prunes expired archives and their turns for every owner, keeping a still-referenced id", () => {
  const s = new ConversationStore(file);
  const at = (iso: string) => new ConversationCatalog(file, "discord", () => new Date(iso));
  const teams = new ConversationCatalog(file, "teams", () => new Date("2026-10-30T00:00:00.000Z"));
  // Turns first: append bumps a catalogued row's updated_at to the real clock.
  s.append("old", { role: "user", content: "x" });
  at("2026-01-01T00:00:00.000Z").upsert({ conversationId: "old", place: { kind: "dm", title: "DM" }, ownerId: "someone-else" });
  const oldArchive = s.clear("old")!;
  s.append("both", { role: "user", content: "y" });
  // Same id catalogued on two surfaces: one copy expires, the other still references the turns.
  at("2026-01-01T00:00:00.000Z").upsert({ conversationId: "both", place: { kind: "dm", title: "DM" }, ownerId: "u1" });
  teams.upsert({ conversationId: "both", place: { kind: "dm", title: "DM" }, ownerId: "u1" });
  const shared = s.clear("both")!;
  const now = new Date("2026-11-01T00:00:00.000Z");
  const rows = listChatopsConversations(file, owner, now);
  expect(rows.map((r) => r.conversationId)).toEqual(["both"]);
  expect(s.history(oldArchive)).toEqual([]);
  expect(at(now.toISOString()).get(oldArchive)).toBeUndefined();
  expect(s.history(shared)).toEqual([{ role: "user", content: "y" }]);
  expect(listChatopsConversations(file, [{ surface: "teams", ownerId: "u1" }], now).map((r) => r.archivedFrom)).toEqual([undefined, "both"]);
});

test("a bean.db from before archived_from gains it on open", async () => {
  closeDb(file);
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE chatops_conversations (conversation_id TEXT NOT NULL, surface TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, owner_id TEXT NOT NULL, owner_alt_id TEXT, live_cli TEXT, live_session_id TEXT,
    updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, surface))`);
  legacy.exec("INSERT INTO chatops_conversations VALUES ('c1', 'discord', 'dm', 'DM', 'u1', NULL, NULL, NULL, '2026-10-30T00:00:00.000Z')");
  legacy.close();
  expect(listChatopsConversations(file, owner)).toEqual([expect.objectContaining({ conversationId: "c1" })]);
  expect(new ConversationCatalog(file, "discord").get("c1")?.archivedFrom).toBeUndefined();
});

test("loadChatopsOwners reads each surface's configured owner, skipping missing ones", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { loadChatopsOwners } = await import("../src/chatops/catalog.js");
  expect(await loadChatopsOwners(dir)).toEqual([]);
  await writeFile(join(dir, "discord.json"), JSON.stringify({ botToken: "t", allowedUserIds: ["legacy-owner"] }));
  await writeFile(join(dir, "teams.json"), JSON.stringify({ ownerId: "aad-1", ownerName: "Scen" }));
  expect(await loadChatopsOwners(dir)).toEqual([
    { surface: "discord", ownerId: "legacy-owner", ownerName: "the owner" },
    { surface: "teams", ownerId: "aad-1", ownerName: "Scen" },
  ]);
  await writeFile(join(dir, "teams.json"), "{not json");
  expect((await loadChatopsOwners(dir)).map((o) => o.surface)).toEqual(["discord"]);
});
