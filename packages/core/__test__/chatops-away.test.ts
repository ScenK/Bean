import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AWAY_PREPARE_LIMITS, AWAY_REASON_MAX, AWAY_SUMMARY_MAX, closeAway, awaySummary, closeAwayToOwnerDm, makeAway, parseAwayCommand, runAwayCommand,
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

test("prepare caps hold across a reopen: queue, per sender and per surface per day (#909)", () => {
  const file = db();
  const away = makeAway({ dbPath: file, surface: "discord" });
  const claim = (n: number, sender: string, a = away, now?: Date) =>
    a.claimPrepare({ conversationId: "c1", messageId: `m${n}`, senderId: sender, project: "scratch", brief: "b" }, now);
  // The queue holds 5 (nothing running here).
  for (let i = 0; i < AWAY_PREPARE_LIMITS.queued; i++) expect(claim(i, `s${i}`)).toBeUndefined();
  expect(claim(5, "s5")).toBe("the queue was full");
  expect(claim(0, "s0")).toBe("already claimed");
  // Drain the queue; a fresh handle (a bot restart) still counts today's claims.
  for (let i = 0; i < AWAY_PREPARE_LIMITS.queued; i++) away.finishPrepare(away.nextPrepare()!.id, { status: "prepared", result: "ok" });
  const again = makeAway({ dbPath: file, surface: "discord" });
  for (let i = 10; i < 10 + AWAY_PREPARE_LIMITS.senderPerDay; i++) {
    expect(claim(i, "mia", again)).toBeUndefined();
    again.finishPrepare(again.nextPrepare()!.id, { status: "failed", result: "x" });
  }
  expect(claim(20, "mia", again)).toBe("the daily limit for this sender was reached");
  for (let i = 30; claim(i, `t${i}`, again) === undefined; i++) again.finishPrepare(again.nextPrepare()!.id, { status: "failed", result: "x" });
  expect(claim(99, "zed", makeAway({ dbPath: file, surface: "discord" }))).toBe("the daily limit for this chat app was reached");
  // Tomorrow, and the other surface, start fresh.
  expect(claim(100, "zed", again, new Date(Date.now() + 86_400_000))).toBeUndefined();
  expect(claim(101, "zed", makeAway({ dbPath: file, surface: "teams" }))).toBeUndefined();
});

test("one prepare runs at a time; a restart marks the running one interrupted", () => {
  const file = db();
  const away = makeAway({ dbPath: file, surface: "discord" });
  for (const n of [1, 2]) away.claimPrepare({ conversationId: "c1", messageId: `m${n}`, senderId: "mia", project: "scratch", brief: "b" });
  const first = away.nextPrepare()!;
  expect(away.nextPrepare()).toBeUndefined();
  makeAway({ dbPath: file, surface: "discord" }).interruptPrepares("interrupted");
  expect(away.prepareStatus(first.id)).toBe("failed");
  expect(away.nextPrepare()?.id).not.toBe(first.id);
});

test("the summary shows prepared, failed and not-prepared entries (#909)", () => {
  const away = makeAway({ dbPath: db(), surface: "discord" });
  away.setOn(undefined, 1);
  const tag = (n: number) => {
    away.capture({ conversationId: "c1", messageId: `m${n}`, senderId: `s${n}`, senderName: `S${n}`, text: `t${n}`, at: n + 1, awaySince: 1 });
    return away.claimPrepare({ conversationId: "c1", messageId: `m${n}`, senderId: `s${n}`, project: n === 1 ? "bean" : "scratch", brief: "b" });
  };
  tag(1);
  away.finishPrepare(away.nextPrepare()!.id, {
    status: "prepared", result: "Fix the token check.\n\n```\n# fake header\n", cli: "codex",
    sessionId: "019a0000-0000-7000-8000-000000000000", projectPath: "/p/bean",
  });
  tag(2);
  away.finishPrepare(away.nextPrepare()!.id, { status: "failed", result: "Timed out after 20 minutes." });
  for (let n = 3; n < 3 + AWAY_PREPARE_LIMITS.queued; n++) tag(n);
  expect(tag(9)).toBe("the queue was full");
  away.capture({ conversationId: "c1", messageId: "m10", senderId: "s10", senderName: "S10", text: "no prepare", at: 20, awaySince: 1 });
  const s = closeAway(away)!;
  expect(s).toContain("- S1: `t1`\n  - Prepared a plan (bean): `Fix the token check. / ''' / # fake header` Resume: `cd '/p/bean' && codex resume 019a0000-0000-7000-8000-000000000000`");
  expect(s).toContain("- S2: `t2`\n  - Prepare failed (scratch): `Timed out after 20 minutes.`");
  expect(s).toContain("- S3: `t3`\n  - Prepare cancelled: away mode ended.");
  expect(s).toContain("- S9: `t9`\n  - Not prepared: `the queue was full`");
  expect(s.endsWith("- S10: `no prepare`")).toBe(true); // a capture without a prepare gets no sub-line
});
