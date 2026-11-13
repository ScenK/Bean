import { describe, expect, it } from "vitest";
import { busySummary } from "../src/renderer/components/about/CoreUpdate.js";

describe("About's core busy list (#838)", () => {
  it("counts a kind with several items and names a lone one", () => {
    expect(busySummary(["delegate a", "delegate b", "sprout Morning"])).toBe("2 delegates, sprout Morning");
    expect(busySummary(["agent Claude · bean"])).toBe("agent Claude · bean");
  });
});
