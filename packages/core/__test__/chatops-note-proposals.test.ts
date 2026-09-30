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

const img = (kb: number) => ({ data: "A".repeat(Math.ceil((kb * 1024 * 4) / 3)), mimeType: "image/png" });

test("claim from another conversation claims nothing and leaves the proposal", () => {
  const s = new NoteProposalStore(() => 0);
  const p = s.add(base);
  expect(s.claim(p.id, "other")).toBeUndefined();
  expect(s.claim(p.id, "c1")?.id).toBe(p.id);
});

test("recent images are held per conversation for the expiry window", () => {
  let now = 0;
  const s = new NoteProposalStore(() => now);
  s.rememberImages("c1", [img(1)]);
  expect(s.recentImages("c1")).toHaveLength(1);
  expect(s.recentImages("c2")).toBeUndefined();
  now = 10 * 60_000 + 1;
  expect(s.recentImages("c1")).toBeUndefined();
});

test("the global byte cap evicts the oldest holders first", () => {
  let now = 0;
  const s = new NoteProposalStore(() => now, 3 * 1024);
  s.rememberImages("old", [img(2)]);
  now = 1;
  const p = s.add({ ...base, images: [img(2)] }); // 4 KB > 3 KB → "old" slot evicted
  expect(s.recentImages("old")).toBeUndefined();
  now = 2;
  s.rememberImages("new", [img(2)]); // evicts the (older) proposal whole
  expect(s.claim(p.id)).toBeUndefined();
  expect(s.recentImages("new")).toHaveLength(1);
});

test("expired entries are pruned on insert, not only on claim", () => {
  let now = 0;
  const s = new NoteProposalStore(() => now, 3 * 1024);
  const p = s.add({ ...base, images: [img(2)] });
  now = 10 * 60_000 + 1;
  s.rememberImages("c2", [img(2)]); // would exceed the cap only if the expired proposal still counted
  expect(s.recentImages("c2")).toHaveLength(1);
  expect(s.claim(p.id)).toBeUndefined();
});
