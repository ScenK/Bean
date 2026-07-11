import { expect, test } from "vitest";
import { chunkText } from "../src/chunk.js";

test("short text passes through as one chunk", () => {
  expect(chunkText("hello")).toEqual(["hello"]);
});

test("empty text yields no chunks", () => {
  expect(chunkText("")).toEqual([]);
});

test("splits on line boundaries under the limit", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
  const chunks = chunkText(lines.join("\n"), 120);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
  expect(chunks.join("\n")).toBe(lines.join("\n")); // nothing lost
});

test("hard-splits a single over-long line", () => {
  const long = "a".repeat(4500);
  const chunks = chunkText(long, 2000);
  expect(chunks).toEqual(["a".repeat(2000), "a".repeat(2000), "a".repeat(500)]);
});
