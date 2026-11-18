import { expect, test } from "vitest";
import { cardRecord, CARD_RECORD_PREFIX, isCardRecord, runEndState } from "../src/card-record.js";

test("formats kind, catalog name and state on one line", () => {
  expect(cardRecord("sprout", "running", "pr-digest")).toBe('[card: sprout "pr-digest" — running]');
  expect(cardRecord("note", "saved")).toBe("[card: note — saved]");
  expect(isCardRecord(cardRecord("send", "pending"))).toBe(true);
  expect(isCardRecord("[delegate result] x")).toBe(false);
  expect(CARD_RECORD_PREFIX).toBe("[card: ");
});

test("a name is clipped to one short line with no quotes or brackets", () => {
  const line = cardRecord("skill", "pending", `a "b"]\n[c ${"x".repeat(100)}`);
  expect(line).not.toContain("\n");
  expect(line).toMatch(/^\[card: skill "a b c x+" — pending\]$/);
  expect(line.length).toBeLessThan(100);
  expect(cardRecord("sprout", "pending", "  ")).toBe("[card: sprout — pending]");
});

test("a run's outcome line maps to its end state (renderer and chatops wording)", () => {
  expect(runEndState("Finished")).toBe("finished");
  expect(runEndState("pr-digest finished ✓")).toBe("finished");
  expect(runEndState("Needs attention")).toBe("needs attention");
  expect(runEndState("pr-digest needs attention ⚠")).toBe("needs attention");
  expect(runEndState("Interrupted — Bean restarted before it finished, nothing was re-run")).toBe("interrupted");
  expect(runEndState("Failed")).toBe("failed");
});
