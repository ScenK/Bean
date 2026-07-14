import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/chatops/conversation.js";
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

test("replaceOldest collapses the oldest n turns into one summary turn, keeping the rest", () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < 10; i++) s.append("c1", { role: "user", content: `m${i}` });
  s.replaceOldest("c1", 6, { role: "system", content: "summary of m0..m5" });
  const h = s.history("c1");
  expect(h.map((t) => t.content)).toEqual(["summary of m0..m5", "m6", "m7", "m8", "m9"]);
  expect(h[0]?.role).toBe("system");
});
