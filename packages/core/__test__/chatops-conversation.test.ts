import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, MAX_ARCHIVED_SESSIONS, sessionCommand } from "../src/chatops/conversation.js";
import { closeDb } from "../src/db.js";
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

test("/new archives the session and /resume swaps it back, archiving the current one", () => {
  const s = new ConversationStore(file);
  s.append("c1", { role: "user", content: "first topic" });
  s.append("c1", { role: "assistant", content: "about the first" });
  s.append("c2", { role: "user", content: "other channel" });
  expect(sessionCommand(s, "c1", "new")).toMatch(/fresh start/i);
  expect(s.history("c1")).toEqual([]);
  s.append("c1", { role: "user", content: "second topic" });

  const list = sessionCommand(s, "c1", "sessions")!;
  expect(list).toContain("1.");
  expect(list).toContain("first topic");
  expect(list).not.toContain("other channel");

  const resumed = sessionCommand(s, "c1", "resume 1")!;
  expect(resumed).toContain("about the first");
  expect(s.history("c1").map((t) => t.content)).toEqual(["first topic", "about the first"]);
  expect(s.archived("c1").map((a) => a.preview)).toEqual(["second topic"]);
  expect(s.history("c2")).toHaveLength(1);
  expect(sessionCommand(s, "c1", "resume 5")).toMatch(/no session 5/i);
  expect(sessionCommand(s, "c1", "hello")).toBeUndefined();
});

test("archives are capped, and resuming the oldest survives the trim", () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 2; i++) {
    s.append("c1", { role: "user", content: `topic ${i}` });
    s.archive("c1");
  }
  const archived = s.archived("c1");
  expect(archived).toHaveLength(MAX_ARCHIVED_SESSIONS);
  s.append("c1", { role: "user", content: "live" });
  expect(s.resume("c1", archived.length - 1)).toBe(true);
  expect(s.history("c1")).toEqual([{ role: "user", content: archived.at(-1)!.preview }]);
  expect(s.archived("c1")).toHaveLength(MAX_ARCHIVED_SESSIONS);
});

test("a resumed session re-archived by /new is not the one trimmed", async () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < MAX_ARCHIVED_SESSIONS; i++) {
    s.append("c1", { role: "user", content: `topic ${i}` });
    s.archive("c1");
    await new Promise((r) => setTimeout(r, 2)); // distinct archive timestamps
  }
  s.append("c1", { role: "user", content: "live" });
  s.resume("c1", MAX_ARCHIVED_SESSIONS - 1); // oldest: "topic 0"
  s.archive("c1");
  expect(s.archived("c1")[0]?.preview).toBe("topic 0");
  expect(s.archived("c1").map((a) => a.preview)).toContain("live");
});
