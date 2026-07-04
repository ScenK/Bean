import { expect, test } from "vitest";
import { truncateMiddle } from "../src/renderer/components/projects/truncate-path.js";

test("short paths pass through unchanged", () => {
  expect(truncateMiddle("/Users/scen/dev/acme")).toBe("/Users/scen/dev/acme");
});

test("long paths keep the start and end, ellipsis in the middle", () => {
  const path = "/Users/scen/Develop/some/deeply/nested/workspace/folder/acme";
  const out = truncateMiddle(path, 42);
  expect(out.length).toBeLessThanOrEqual(42);
  expect(out.startsWith("/Users/scen/Develop")).toBe(true);
  expect(out.endsWith("acme")).toBe(true);
  expect(out).toContain("...");
});
