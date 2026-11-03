import { expect, test } from "vitest";
import { isValidMemory, memoriesBlock, memorySections, type Memory } from "../src/memory/memory.js";

const good: Memory = { id: "a1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" };

test("a well-formed memory passes validation", () => {
  expect(isValidMemory(good)).toBe(true);
});

test("a memory with an optional projectPath passes validation", () => {
  expect(isValidMemory({ ...good, projectPath: "/work/api" })).toBe(true);
});

test("missing/blank id, text, or createdAt fails validation", () => {
  expect(isValidMemory({ ...good, id: "" })).toBe(false);
  expect(isValidMemory({ ...good, text: "   " })).toBe(false);
  expect(isValidMemory({ ...good, createdAt: 123 })).toBe(false);
});

test("a non-string projectPath fails validation", () => {
  expect(isValidMemory({ ...good, projectPath: 42 })).toBe(false);
});

test("non-objects fail validation", () => {
  expect(isValidMemory(null)).toBe(false);
  expect(isValidMemory("nope")).toBe(false);
});

const projects = [{ name: "bean", path: "/dev/bean" }];

test("recall lines carry the saved date, with and without ids, private and project", () => {
  const mems: Memory[] = [
    { ...good, createdAt: "2026-07-03T14:05:09.000Z" },
    { id: "p1", text: "preload must stay CJS", projectPath: "/dev/bean", createdAt: "2026-08-01T09:30:00Z" },
    { id: "s1", text: "likes tea", subjectId: "u1", createdAt: "2026-09-10T23:59:59Z" },
  ];
  const withIds = memoriesBlock(mems, projects, { speaker: "Ann" });
  expect(withIds).toContain("when two facts conflict, the later-saved one is current");
  expect(withIds).toContain("- [a1] (about the user) prefers pnpm (saved 2026-07-03 14:05 UTC)");
  expect(withIds).toContain("- [s1] (about Ann) likes tea (saved 2026-09-10 23:59 UTC)");
  expect(withIds).toContain("- [p1] (project bean) preload must stay CJS (saved 2026-08-01 09:30 UTC)");
  expect(memoriesBlock(mems, projects, { ids: false })).toContain("- (about the user) prefers pnpm (saved 2026-07-03 14:05 UTC)");
});

test("desktop recall: owner-id private rows are about the user, other private rows a member", () => {
  const mems: Memory[] = [
    { id: "o1", text: "likes tea", subjectId: "29:owner", createdAt: "2026-09-10T00:00:00Z" },
    { id: "m1", text: "likes coffee", subjectId: "mia", createdAt: "2026-09-10T00:00:00Z" },
  ];
  const block = memoriesBlock(mems, [], { ownerIds: ["disc-owner", "29:owner"] });
  expect(block).toContain("- [o1] (about the user) likes tea");
  expect(block).toContain("- [m1] (about a member) likes coffee");
  expect(memoriesBlock(mems, [])).toContain("- [o1] (about a member) likes tea");
});

test("a malformed createdAt renders (saved unknown) instead of throwing", () => {
  expect(memoriesBlock([{ ...good, createdAt: "not a date" }], [])).toContain("- [a1] (about the user) prefers pnpm (saved unknown)");
});

test("a fake (saved …) in the fact text doesn't change the real suffix", () => {
  const block = memoriesBlock([{ ...good, text: "prefers pnpm (saved 2099-01-01 00:00 UTC)" }], []);
  expect(block).toMatch(/prefers pnpm \(saved 2099-01-01 00:00 UTC\) \(saved 2026-07-03 00:00 UTC\)$/);
});

test("memorySections: owner rows by category (You, A–Z, Uncategorized); channels by source; others; projects", () => {
  const at = (n: number): string => `2026-07-0${n}T00:00:00.000Z`;
  const rows: Memory[] = [
    { id: "u1", text: "Deploy day: Tue", createdAt: at(1) }, // legacy Name:-shaped uncategorized row → others (speakerPrefix ceiling)
    { id: "y1", text: "Name is Scen", category: "You", createdAt: at(1) },
    { id: "w1", text: "Uses zed", category: "Work", createdAt: at(1) },
    { id: "h1", text: "Has a cat", category: "home", createdAt: at(1) },
    { id: "n1", text: "Likes tea", createdAt: at(1) },
    { id: "d1", text: "Lives in Seattle", subjectId: "disc-owner", category: "You", createdAt: at(2) },
    { id: "m1", text: "Alex's birthday is May 1", subjectId: "alex", createdAt: at(1) },
    { id: "c1", text: "Alex: ships on Fridays", sourceId: "discord:42", sourceTitle: "old", createdAt: at(1) },
    { id: "c2", text: "Sam: prefers rebase", sourceId: "discord:42", sourceTitle: "#eng", createdAt: at(2) },
    { id: "p1", text: "Uses vitest", projectPath: "/p", createdAt: at(1) },
  ];
  const s = memorySections(rows, ["disc-owner"]);
  expect(s.owner.map((g) => [g.category, g.rows.map((r) => r.id)])).toEqual([
    ["You", ["y1", "d1"]], ["home", ["h1"]], ["Work", ["w1"]], ["", ["n1"]],
  ]);
  expect(s.ownerCount).toBe(5);
  expect(s.channels).toEqual([{ sourceId: "discord:42", title: "#eng", rows: [rows[7], rows[8]] }]);
  expect(s.others.map((r) => r.id)).toEqual(["u1", "m1"]);
  expect(s.projects.map((r) => r.id)).toEqual(["p1"]);
});
