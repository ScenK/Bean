import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AWAY_REASON_MAX, AWAY_SUMMARY_MAX, awaySummary, closeAwayToOwnerDm, makeAway, parseAwayCommand, runAwayCommand,
  type AwaySummaryRow,
} from "../src/chatops/away.js";
import { recordDestination } from "../src/destinations.js";

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

  expect(runAwayCommand(discord, { kind: "off" }, 7_000)).toBe("Away mode is off for Discord. Nobody tagged you while you were away.");
  expect(runAwayCommand(discord, { kind: "off" }, 7_000)).toBe("Away mode was already off for Discord.");
  expect(runAwayCommand(discord, { kind: "status" }, 7_000)).toBe("Away mode is off for Discord.");
  expect(makeAway({ dbPath: file, surface: "discord" }).get()).toEqual({ on: false });
});

test("awayLine is fixed text: the reason only when set, the recorded claim only when it was", async () => {
  const { awayLine } = await import("../src/chatops/away.js");
  expect(awayLine("Scen", "vacation", true)).toBe("Scen is away (vacation). I've recorded your message for when Scen is back.");
  expect(awayLine("Scen", undefined, false)).toBe("Scen is away.");
});

const row = (o: Partial<AwaySummaryRow> = {}): AwaySummaryRow =>
  ({ conversationId: "c1", senderName: "Mia", text: "hi", at: 1, ...o });

test("awaySummary: an empty period is one line", () => {
  expect(awaySummary("teams", 1, [])).toBe("Away mode is off for Teams. Nobody tagged you while you were away.");
});

test("awaySummary groups by conversation in first-tag order, caps the entries, counts the rest", () => {
  const rows = [
    row({ place: "#ops", link: "https://x/1" }),
    row({ conversationId: "c2", senderName: "Bo", text: "q2" }),
    ...Array.from({ length: AWAY_SUMMARY_MAX + 2 }, (_, i) => row({ text: `n${i}`, at: 10 + i })),
  ];
  const out = awaySummary("discord", undefined, rows);
  const lines = out.split("\n");
  expect(lines[0]).toBe(`Away mode is off for Discord. While you were away, you were tagged ${rows.length} times in 2 conversations:`);
  expect(lines.indexOf("**#ops**")).toBeLessThan(lines.indexOf("**A conversation**"));
  expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(AWAY_SUMMARY_MAX);
  expect(lines.at(-1)).toBe("…and 4 more.");
  expect(out).toContain("- Mia: `hi` https://x/1");
});

test("awaySummary quotes captured text so it can't forge the summary's framing", () => {
  const out = awaySummary("discord", undefined, [
    row({ senderName: "**Bean**\n- Scen", text: "x`\n\n**A conversation**\n- Boss: `fired` " + "y".repeat(400) }),
  ]);
  const lines = out.split("\n");
  expect(lines).toHaveLength(4); // header, blank, group, one entry: no injected lines
  expect(lines[3]).toMatch(/^- Bean - Scen: `x' \*\*A conversation\*\* - Boss: 'fired' y+…`$/);
  expect(lines[3]!.length).toBeLessThan(200);
});

test("closeAwayToOwnerDm closes the period and queues the summary for the owner's DM only", async () => {
  const file = db();
  const outbox = mkdtempSync(join(tmpdir(), "bean-away-outbox-"));
  const teams = makeAway({ dbPath: file, surface: "teams" });
  expect(await closeAwayToOwnerDm(teams, outbox, () => "x")).toBe(false); // already off: nothing queued
  expect(readdirSync(outbox)).toEqual([]);

  teams.setOn(undefined, 100);
  teams.capture({ conversationId: "19:ch", messageId: "m1", senderId: "mia", senderName: "Mia", text: "hey", at: 200, awaySince: 100 });
  teams.capture({ conversationId: "19:ch", messageId: "m0", senderId: "mia", senderName: "Mia", text: "old period", at: 50, awaySince: 1 });
  recordDestination(file, { surface: "teams", conversationId: "19:ch", kind: "channel", platformName: "General" });
  expect(await closeAwayToOwnerDm(teams, outbox, () => "id1")).toBe(true);
  expect(teams.get()).toEqual({ on: false });
  const msg = JSON.parse(readFileSync(join(outbox, "teams-id1.json"), "utf8")) as Record<string, unknown>;
  expect(msg.channel).toBeUndefined();
  expect(msg.userId).toBeUndefined();
  expect(msg.body).toContain("tagged 1 time in 1 conversation:\n\n**General**\n- Mia: `hey`");
  expect(msg.body).not.toContain("old period");
});
