import { expect, test } from "vitest";
import { isValidMemory, type Memory } from "../src/memory/memory.js";

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
