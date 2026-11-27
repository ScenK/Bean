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
  groups.record(["old1", "old2"], { now: new Date(2026, 0, 1) });
  groups.record(["new1", "new2"], { now: new Date(2026, 0, 31) });
  expect(groups.group("old1")).toBeDefined();
  groups.record(["new3", "new4"], { now: new Date(2026, 1, 1) });
  expect(groups.group("old1")).toBeUndefined();
  expect(groups.group("new1")).toEqual({ ids: ["new1", "new2"], index: 0 });
});

test("a sprout post records its sprout on every chunk, even a single one; other posts carry none (#1134)", () => {
  const groups = makeChunkGroups({ dbPath: db() });
  groups.record(["d1", "d2"], { sprout: "Bean Triage" });
  groups.record(["s1"], { sprout: "digest" });
  groups.record(["p1", "p2"]);
  expect(groups.group("d2")).toEqual({ ids: ["d1", "d2"], index: 1, sprout: "Bean Triage" });
  expect(groups.group("s1")).toEqual({ ids: ["s1"], index: 0, sprout: "digest" });
  expect(groups.group("p1")).toEqual({ ids: ["p1", "p2"], index: 0 });
});
