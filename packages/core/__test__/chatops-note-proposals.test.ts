import { expect, test } from "vitest";
import { NoteProposalStore } from "../src/chatops/note-proposals.js";

const note = { title: "Our chat", body: "## Summary\n\nstuff" };
const base = { note, conversationId: "c1", proposedBy: "alice" };

test("add assigns unique note-* ids and claim is one-shot", () => {
  const s = new NoteProposalStore(() => 0);
  const a = s.add(base);
  const b = s.add(base);
  expect(a.id).toMatch(/^note-\d+$/);
  expect(a.id).not.toBe(b.id);
  expect(s.claim(a.id)?.proposedBy).toBe("alice");
  expect(s.claim(a.id)).toBeUndefined(); // already claimed
});

test("claim returns undefined after the 10-minute expiry", () => {
  let now = 0;
  const s = new NoteProposalStore(() => now);
  const p = s.add(base);
  now = 10 * 60_000 + 1;
  expect(s.claim(p.id)).toBeUndefined();
});

test("setCardActivityId records the card message id for later edits", () => {
  const s = new NoteProposalStore(() => 0);
  const p = s.add(base);
  s.setCardActivityId(p.id, "act-9");
  expect(s.claim(p.id)?.cardActivityId).toBe("act-9");
});

test("claim of an unknown id returns undefined", () => {
  expect(new NoteProposalStore().claim("nope")).toBeUndefined();
});
