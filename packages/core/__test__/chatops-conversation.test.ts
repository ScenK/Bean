import { expect, test } from "vitest";
import { ConversationStore } from "../src/chatops/conversation.js";

test("returns empty history for an unknown conversation", () => {
  expect(new ConversationStore().history("c1")).toEqual([]);
});

test("appends turns per conversation independently", () => {
  const s = new ConversationStore();
  s.append("c1", { role: "user", content: "hi" });
  s.append("c1", { role: "assistant", content: "hello" });
  s.append("c2", { role: "user", content: "other" });
  expect(s.history("c1")).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  expect(s.history("c2")).toHaveLength(1);
});

test("caps history at the most recent 40 turns", () => {
  const s = new ConversationStore();
  for (let i = 0; i < 45; i++) s.append("c1", { role: "user", content: `m${i}` });
  const h = s.history("c1");
  expect(h).toHaveLength(40);
  expect(h[0]?.content).toBe("m5");
  expect(h[39]?.content).toBe("m44");
});
