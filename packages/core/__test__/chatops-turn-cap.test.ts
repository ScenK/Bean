import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { localDay, makeTurnCap } from "../src/chatops/turn-cap.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-turncap-")), "bean.db");
const turn = (n: number, userId = "ana") => ({ turnId: `m${userId}${n}`, userId, userName: userId });

test("the cap admits exactly `cap` turns per member per day; others are unaffected", () => {
  const cap = makeTurnCap({ dbPath: db(), surface: "discord", cap: 3 });
  const now = new Date(2026, 9, 13, 12);
  expect([1, 2, 3, 4].map((n) => cap.admit(turn(n), now))).toEqual([true, true, true, false]);
  expect(cap.admit(turn(1, "bob"), now)).toBe(true);
  expect(cap.usage(now)).toEqual([{ userId: "ana", name: "ana", count: 3 }, { userId: "bob", name: "bob", count: 1 }]);
});

test("a redelivered message id is admitted again without counting twice", () => {
  const cap = makeTurnCap({ dbPath: db(), surface: "discord", cap: 2 });
  const now = new Date(2026, 9, 13, 12);
  expect(cap.admit(turn(1), now)).toBe(true);
  expect(cap.admit(turn(1), now)).toBe(true);
  expect(cap.admit(turn(2), now)).toBe(true);
  expect(cap.admit(turn(3), now)).toBe(false);
  expect(cap.usage(now)[0]?.count).toBe(2);
});

test("the count resets at local midnight and old days are pruned", () => {
  const dbPath = db();
  const cap = makeTurnCap({ dbPath, surface: "discord", cap: 1 });
  expect(cap.admit(turn(1), new Date(2026, 9, 13, 23, 59))).toBe(true);
  expect(cap.admit(turn(2), new Date(2026, 9, 13, 23, 59, 59))).toBe(false);
  expect(cap.admit(turn(3), new Date(2026, 9, 14, 0, 0, 1))).toBe(true);
  expect(cap.usage(new Date(2026, 9, 13, 12))).toEqual([]);
  expect(localDay(new Date(2026, 9, 14, 0, 0, 1))).toBe("2026-10-14");
});

test("two handles on one db (parallel DM + channel turns) can't pass the cap", () => {
  const dbPath = db();
  const a = makeTurnCap({ dbPath, surface: "discord", cap: 5 });
  const b = makeTurnCap({ dbPath, surface: "discord", cap: 5 });
  const now = new Date(2026, 9, 13, 12);
  const admitted = Array.from({ length: 10 }, (_, n) => (n % 2 ? a : b).admit(turn(n), now)).filter(Boolean);
  expect(admitted).toHaveLength(5);
});

test("counts are per surface", () => {
  const dbPath = db();
  const now = new Date(2026, 9, 13, 12);
  makeTurnCap({ dbPath, surface: "discord", cap: 1 }).admit(turn(1), now);
  expect(makeTurnCap({ dbPath, surface: "teams", cap: 1 }).admit(turn(2), now)).toBe(true);
});
