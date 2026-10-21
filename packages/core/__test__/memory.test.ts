import { expect, test } from "vitest";
import { isValidMemory, memoriesBlock, type Memory } from "../src/memory/memory.js";

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

test("a malformed createdAt renders (saved unknown) instead of throwing", () => {
  expect(memoriesBlock([{ ...good, createdAt: "not a date" }], [])).toContain("- [a1] (about the user) prefers pnpm (saved unknown)");
});

test("a fake (saved …) in the fact text doesn't change the real suffix", () => {
  const block = memoriesBlock([{ ...good, text: "prefers pnpm (saved 2099-01-01 00:00 UTC)" }], []);
  expect(block).toMatch(/prefers pnpm \(saved 2099-01-01 00:00 UTC\) \(saved 2026-07-03 00:00 UTC\)$/);
});
