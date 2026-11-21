import { describe, expect, it } from "vitest";
import { keyedTurns } from "../src/renderer/components/chat/agent-mode.js";
import type { ChatItem } from "../src/renderer/shared/chat-types.js";

// Home on the main log (#997): the keys the host dedupes on.
describe("keyedTurns", () => {
  it("keys turns by item id, cards by id + record, and leaves posts and summaries out", () => {
    const items = [
      { kind: "user", id: "u1", text: "hi", source: "typed" },
      { kind: "reply", id: "r1", text: "hello" },
      { kind: "note", id: "n1", note: { title: "T", body: "B" }, state: "pending" },
      { kind: "post", id: "p1", postId: "x", sprout: "digest", at: "2026-11-20T00:00:00Z", text: "news" },
      { kind: "summary", id: "s1", text: "earlier" },
      { kind: "status", id: "st", text: "ok", tone: "info" },
    ] as ChatItem[];
    const out = keyedTurns(items);
    expect(out.map((t) => t.key)).toEqual(["u1", "r1", expect.stringMatching(/^n1:\[card: note/)]);
    expect(out.map((t) => t.content)).not.toContain("earlier");
    // A card's next state is one more line, under a new key.
    const saved = keyedTurns([{ ...items[2], state: "saved" } as ChatItem]);
    expect(saved[0]!.key).not.toBe(out[2]!.key);
  });
});
