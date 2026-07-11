import { describe, expect, it } from "vitest";
import { mentionsBotName } from "../src/chatops/addressing.js";

describe("mentionsBotName", () => {
  it("matches the name case-insensitively at word boundaries", () => {
    expect(mentionsBotName("hey Bean, look at this", "bean")).toBe(true);
    expect(mentionsBotName("BEAN can you check?", "Bean")).toBe(true);
    expect(mentionsBotName("bean", "bean")).toBe(true);
  });

  it("does not match the name inside another word", () => {
    expect(mentionsBotName("I love beans and beanbags", "bean")).toBe(false);
    expect(mentionsBotName("caribbean vibes", "bean")).toBe(false);
  });

  it("handles empty or regex-special names safely", () => {
    expect(mentionsBotName("anything", "")).toBe(false);
    expect(mentionsBotName("hey bean+bot!", "bean+bot")).toBe(true);
  });
});
