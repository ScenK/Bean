import { describe, expect, it } from "vitest";
import { describeWatchWindowError, inWatchWindow, nextWindowStart, watchWindowMinutes, watchWindowText } from "../src/watch-window.js";
import { describeRoutineError, type Routine } from "../src/routine-store.js";
import { watchSourceKey } from "../src/watch.js";

const at = (h: number, m = 0) => new Date(2026, 9, 2, h, m);

describe("watch window", () => {
  it("from is inclusive, to exclusive, open end runs to midnight, from > to wraps", () => {
    expect(inWatchWindow(undefined, at(3))).toBe(true);
    const day = { from: "09:00", to: "17:00" };
    expect(inWatchWindow(day, at(9))).toBe(true);
    expect(inWatchWindow(day, at(16, 59))).toBe(true);
    expect(inWatchWindow(day, at(17))).toBe(false);
    expect(inWatchWindow(day, at(8, 59))).toBe(false);
    const night = { from: "20:00", to: "06:00" };
    expect(inWatchWindow(night, at(23))).toBe(true);
    expect(inWatchWindow(night, at(5, 59))).toBe(true);
    expect(inWatchWindow(night, at(6))).toBe(false);
    expect(inWatchWindow(night, at(14))).toBe(false);
    expect(inWatchWindow({ from: "20:00" }, at(23, 59))).toBe(true);
    expect(inWatchWindow({ from: "20:00" }, at(0, 1))).toBe(false);
  });

  it("next start: now when inside, today's or tomorrow's opening otherwise", () => {
    expect(nextWindowStart({ from: "20:00" }, at(21))).toEqual(at(21));
    expect(nextWindowStart({ from: "20:00" }, at(14))).toEqual(at(20));
    expect(nextWindowStart({ from: "09:00", to: "17:00" }, at(18))).toEqual(new Date(2026, 9, 3, 9, 0));
  });

  it("length and text", () => {
    expect(watchWindowMinutes({ from: "20:00", to: "06:00" })).toBe(600);
    expect(watchWindowMinutes({ from: "20:00" })).toBe(240);
    expect(watchWindowMinutes({ from: "20:00", to: "21:00" })).toBe(60);
    expect(watchWindowText({ from: "20:00", to: "06:00" })).toBe("20:00–06:00");
    expect(watchWindowText({ from: "20:00" })).toBe("from 20:00");
  });

  it("validation", () => {
    expect(describeWatchWindowError({ from: "20:00", to: "06:00" })).toBeNull();
    expect(describeWatchWindowError({ from: "20:00" })).toBeNull();
    expect(describeWatchWindowError({ from: "8:00" })).toMatch(/start time/);
    expect(describeWatchWindowError({ from: "24:00" })).toMatch(/start time/);
    expect(describeWatchWindowError({ to: "06:00" })).toMatch(/start time/);
    expect(describeWatchWindowError({ from: "20:00", to: "20:00" })).toMatch(/same time/);
    expect(describeWatchWindowError({ from: "20:00", to: "6pm" })).toMatch(/end/);
  });

  it("routine validation checks the window on both watch kinds; absent is fine", () => {
    const r = (watch: Routine["watch"]): Routine => ({ name: "w", enabled: true, watch, steps: [], sinks: {} });
    expect(describeRoutineError(r({ kind: "feed", url: "https://f" }))).toBeNull();
    expect(describeRoutineError(r({ kind: "feed", url: "https://f", window: { from: "20:00", to: "06:00" } }))).toBeNull();
    expect(describeRoutineError(r({ kind: "command", command: "c", window: { from: "20:00", to: "20:00" } }))).toMatch(/same time/);
    expect(describeRoutineError(r({ kind: "feed", url: "https://f", window: { from: "x" } }))).toMatch(/start time/);
  });

  it("the window is not part of the source key (editing it never re-seeds)", () => {
    expect(watchSourceKey({ kind: "command", command: "c", window: { from: "20:00" } })).toBe(watchSourceKey({ kind: "command", command: "c" }));
  });
});
