import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AWAY_REASON_MAX, makeAway, parseAwayCommand, runAwayCommand } from "../src/chatops/away.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-away-")), "bean.db");

test("parses away on/off/status as the whole message; the reason is one capped line", () => {
  expect(parseAwayCommand("away on")).toEqual({ kind: "on" });
  expect(parseAwayCommand("/Away ON  at the\n dentist ")).toEqual({ kind: "on", reason: "at the dentist" });
  expect(parseAwayCommand("away off")).toEqual({ kind: "off" });
  expect(parseAwayCommand(" away status ")).toEqual({ kind: "status" });
  expect(parseAwayCommand("away on " + "x".repeat(500))).toEqual({ kind: "on", reason: "x".repeat(AWAY_REASON_MAX) });
  // Anything else stays an ordinary turn.
  for (const t of ["away", "away off now", "away status please", "I'm away on Friday", "awayon"]) {
    expect(parseAwayCommand(t)).toBeUndefined();
  }
});

test("away state survives a reopen, and Teams and Discord are independent", () => {
  const file = db();
  const discord = makeAway({ dbPath: file, surface: "discord" });
  expect(discord.get()).toEqual({ on: false });
  expect(runAwayCommand(discord, { kind: "on", reason: "vacation" }, 1_000)).toContain("on for Discord (reason: vacation)");
  expect(makeAway({ dbPath: file, surface: "discord" }).get()).toEqual({ on: true, since: 1_000, reason: "vacation" });
  expect(makeAway({ dbPath: file, surface: "teams" }).get()).toEqual({ on: false });

  // On again keeps `since`, replaces the reason (none = cleared).
  runAwayCommand(discord, { kind: "on" }, 5_000);
  expect(discord.get()).toEqual({ on: true, since: 1_000 });
  expect(runAwayCommand(discord, { kind: "status" }, 6_000)).toMatch(/^Away mode is on for Discord since /);

  expect(runAwayCommand(discord, { kind: "off" }, 7_000)).toBe("Away mode is off for Discord.");
  expect(runAwayCommand(discord, { kind: "off" }, 7_000)).toBe("Away mode was already off for Discord.");
  expect(runAwayCommand(discord, { kind: "status" }, 7_000)).toBe("Away mode is off for Discord.");
  expect(makeAway({ dbPath: file, surface: "discord" }).get()).toEqual({ on: false });
});

test("awayLine is fixed text: the reason only when set, the recorded claim only when it was", async () => {
  const { awayLine } = await import("../src/chatops/away.js");
  expect(awayLine("Scen", "vacation", true)).toBe("Scen is away (vacation). I've recorded your message for when Scen is back.");
  expect(awayLine("Scen", undefined, false)).toBe("Scen is away.");
});
