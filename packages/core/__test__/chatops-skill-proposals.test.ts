import { expect, test } from "vitest";
import { SkillProposalStore } from "../src/chatops/skill-proposals.js";

const base = {
  skill: { name: "changelog", body: "# Changelog", updating: false },
  conversationId: "c1",
  proposedBy: "alice",
};

test("add assigns unique ids and claim is one-shot", () => {
  const s = new SkillProposalStore(() => 0);
  const a = s.add(base);
  const b = s.add(base);
  expect(a.id).not.toBe(b.id);
  expect(s.claim(a.id)?.skill.name).toBe("changelog");
  expect(s.claim(a.id)).toBeUndefined(); // already claimed
});

test("claim returns undefined after the 10-minute expiry", () => {
  let now = 0;
  const s = new SkillProposalStore(() => now);
  const p = s.add(base);
  now = 10 * 60_000 + 1;
  expect(s.claim(p.id)).toBeUndefined();
});

test("setCardActivityId records the card message id for later edits", () => {
  const s = new SkillProposalStore(() => 0);
  const p = s.add(base);
  s.setCardActivityId(p.id, "act-9");
  expect(s.claim(p.id)?.cardActivityId).toBe("act-9");
});
