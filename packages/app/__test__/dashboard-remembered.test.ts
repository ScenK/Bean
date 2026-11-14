import { expect, test } from "vitest";
import type { Memory } from "@bean/core";
import { rememberedDays } from "../src/renderer/components/dashboard/remembered.js";

const at = (y: number, mo: number, d: number, h: number): string => new Date(y, mo - 1, d, h).toISOString();
const mem = (id: string, createdAt: string, extra: Partial<Memory> = {}): Memory => ({ id, text: id, createdAt, ...extra });
const now = new Date(2026, 10, 14, 12);

test("groups the owner's visible rows by local day, newest first, and drops another member's private row", () => {
  const days = rememberedDays([
    mem("old-today", at(2026, 11, 14, 8)),
    mem("yesterday", at(2026, 11, 13, 22)),
    mem("new-today", at(2026, 11, 14, 11), { subjectId: "discord:owner" }),
    mem("member", at(2026, 11, 14, 9), { subjectId: "discord:member" }),
  ], ["discord:owner"], now);
  expect(days.map((d) => [d.key, d.rows.map((r) => r.id)])).toEqual([
    ["remembered:2026-11-14", ["new-today", "old-today"]],
    ["remembered:2026-11-13", ["yesterday"]],
  ]);
});

test("a day with no rows has no entry, and days past the window are left to Persona", () => {
  const days = rememberedDays([
    mem("in-window", at(2026, 11, 8, 1)),
    mem("too-old", at(2026, 11, 7, 23)),
    mem("unparsable", "not a date"),
  ], [], now);
  expect(days.map((d) => d.date)).toEqual(["2026-11-08"]);
  expect(rememberedDays([], [], now)).toEqual([]);
});
