import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeChunkGroups } from "../src/chatops/chunk-groups.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-chunks-")), "bean.db");

test("group() returns the ids in send order and the referenced chunk's index", () => {
  const groups = makeChunkGroups({ dbPath: db() });
  groups.record(["a", "b", "c"]);
  expect(groups.group("b")).toEqual({ ids: ["a", "b", "c"], index: 1 });
  expect(groups.group("a")).toEqual({ ids: ["a", "b", "c"], index: 0 });
  expect(groups.group("zzz")).toBeUndefined();
});

test("rows older than 30 days are pruned on insert", () => {
  const groups = makeChunkGroups({ dbPath: db() });
  groups.record(["old1", "old2"], new Date(2026, 0, 1));
  groups.record(["new1", "new2"], new Date(2026, 0, 31));
  expect(groups.group("old1")).toBeDefined();
  groups.record(["new3", "new4"], new Date(2026, 1, 1));
  expect(groups.group("old1")).toBeUndefined();
  expect(groups.group("new1")).toEqual({ ids: ["new1", "new2"], index: 0 });
});
