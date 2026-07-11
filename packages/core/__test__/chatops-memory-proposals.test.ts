import { expect, test } from "vitest";
import { MemoryProposalStore } from "../src/chatops/memory-proposals.js";

const candidates = [{ text: "uses tabs" }, { text: "prefers vitest", projectPath: "/dev/bean" }];
const base = { candidates, conversationId: "c1", proposedBy: "alice" };

test("add assigns unique mem-* ids and claim is one-shot", () => {
  const s = new MemoryProposalStore(() => 0);
  const a = s.add(base);
  const b = s.add(base);
  expect(a.id).toMatch(/^mem-\d+$/);
  expect(a.id).not.toBe(b.id);
  expect(s.claim(a.id)?.proposedBy).toBe("alice");
  expect(s.claim(a.id)).toBeUndefined(); // already claimed
});

test("claim returns undefined after the 10-minute expiry", () => {
  let now = 0;
  const s = new MemoryProposalStore(() => now);
  const p = s.add(base);
  now = 10 * 60_000 + 1;
  expect(s.claim(p.id)).toBeUndefined();
});

test("setCardActivityId records the card message id for later edits", () => {
  const s = new MemoryProposalStore(() => 0);
  const p = s.add(base);
  s.setCardActivityId(p.id, "act-9");
  expect(s.claim(p.id)?.cardActivityId).toBe("act-9");
});

test("claim of an unknown id returns undefined", () => {
  expect(new MemoryProposalStore().claim("nope")).toBeUndefined();
});
