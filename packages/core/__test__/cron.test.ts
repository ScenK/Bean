// packages/core/__test__/cron.test.ts
import { describe, expect, it } from "vitest";
import { isValidCron, nextRun, parseCron } from "../src/cron.js";

// Local-time constructor: (2026, 6, 10) = Jul 10 2026, a Friday.
const d = (y: number, mo: number, day: number, h = 0, mi = 0) => new Date(y, mo, day, h, mi);

describe("parseCron", () => {
  it("parses the 5 fields with *, lists, ranges, steps", () => {
    const spec = parseCron("30 6 * * 1-5");
    expect(spec.minutes.has(30)).toBe(true);
    expect(spec.minutes.size).toBe(1);
    expect(spec.hours.has(6)).toBe(true);
    expect(spec.weekdays.has(1)).toBe(true);
    expect(spec.weekdays.has(5)).toBe(true);
    expect(spec.weekdays.has(0)).toBe(false);
    expect(parseCron("*/15 9-18 * * *").minutes.size).toBe(4);
    expect(parseCron("0 8,12,17 * * *").hours.size).toBe(3);
  });
  it("rejects malformed expressions", () => {
    for (const bad of ["", "30 6 * *", "61 * * * *", "* 25 * * *", "* * * * 8", "a b c d e", "30 6 * * 1-5 extra"]) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });
});

describe("isValidCron", () => {
  it("mirrors parseCron without throwing", () => {
    expect(isValidCron("30 6 * * 1-5")).toBe(true);
    expect(isValidCron("nope")).toBe(false);
  });
});

describe("nextRun", () => {
  it("finds the next weekday 6:30 from a Friday morning", () => {
    // Fri Jul 10 2026 07:00 → next weekday 6:30 is Mon Jul 13 06:30.
    expect(nextRun("30 6 * * 1-5", d(2026, 6, 10, 7, 0))).toEqual(d(2026, 6, 13, 6, 30));
  });
  it("fires later the same day when still ahead", () => {
    expect(nextRun("30 6 * * 1-5", d(2026, 6, 10, 6, 0))).toEqual(d(2026, 6, 10, 6, 30));
  });
  it("is strictly after `from` (exact-match minute rolls to the next occurrence)", () => {
    expect(nextRun("30 6 * * *", d(2026, 6, 10, 6, 30))).toEqual(d(2026, 6, 11, 6, 30));
  });
  it("handles hourly-in-window schedules", () => {
    expect(nextRun("0 9-18 * * *", d(2026, 6, 10, 18, 30))).toEqual(d(2026, 6, 11, 9, 0));
  });
  it("handles day-of-month and month fields", () => {
    expect(nextRun("0 8 1 * *", d(2026, 6, 10))).toEqual(d(2026, 7, 1, 8, 0));
    expect(nextRun("0 8 * 12 *", d(2026, 6, 10))).toEqual(d(2026, 11, 1, 8, 0));
  });
});
