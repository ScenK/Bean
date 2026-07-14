import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeCompact, summarizeTurns } from "../src/chatops/compact.js";
import { ConversationStore } from "../src/chatops/conversation.js";
import { closeDb } from "../src/db.js";
import { dbFile } from "../src/config.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-compact-"));
  file = dbFile(dir);
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

const deps = { chat: async () => ({ content: "summary text", toolCalls: [] }), model: "m" };

test("summarizeTurns returns the model's summary", async () => {
  const summary = await summarizeTurns([{ role: "user", content: "hi" }], deps);
  expect(summary).toBe("summary text");
});

test("summarizeTurns falls back to a placeholder when the model call fails", async () => {
  const summary = await summarizeTurns([{ role: "user", content: "hi" }], {
    chat: async () => { throw new Error("down"); },
    model: "m",
  });
  expect(summary).toBe("(earlier conversation summarized)");
});

test("maybeCompact is a no-op below the threshold", async () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < 10; i++) s.append("c1", { role: "user", content: `m${i}` });
  await maybeCompact("c1", s, deps);
  expect(s.turnCount("c1")).toBe(10);
});

test("maybeCompact summarizes the oldest 40 once over 60 turns", async () => {
  const s = new ConversationStore(file);
  for (let i = 0; i < 61; i++) s.append("c1", { role: "user", content: `m${i}` });
  await maybeCompact("c1", s, deps);
  const h = s.history("c1");
  expect(h).toHaveLength(22); // 61 - 40 + 1 summary turn
  expect(h[0]).toEqual({ role: "system", content: "summary text" });
  expect(h[1]?.content).toBe("m40");
});
