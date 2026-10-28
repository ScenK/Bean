import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeChatter, parseChatterCommand } from "../src/chatops/chatter.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-chatter-")), "bean.db");

test("parser: chatty on/off/status, unmute, and whole-message mutes with clamped durations", () => {
  expect(parseChatterCommand("chatty on")).toEqual({ kind: "chatty", arg: "on" });
  expect(parseChatterCommand("/Chatty OFF")).toEqual({ kind: "chatty", arg: "off" });
  expect(parseChatterCommand("chatty")).toEqual({ kind: "chatty", arg: "status" });
  expect(parseChatterCommand("unmute!")).toEqual({ kind: "unmute" });
  expect(parseChatterCommand("quiet 5m")).toEqual({ kind: "mute", minutes: 5 });
  expect(parseChatterCommand("hush 30m")).toEqual({ kind: "mute", minutes: 30 });
  expect(parseChatterCommand("be quiet")).toEqual({ kind: "mute", minutes: 30 });
  expect(parseChatterCommand("Stay quiet for 2 hours.")).toEqual({ kind: "mute", minutes: 120 });
  expect(parseChatterCommand("mute 0m")).toEqual({ kind: "mute", minutes: 1 });
  expect(parseChatterCommand("mute 48h")).toEqual({ kind: "mute", minutes: 1440 });
  for (const t of ["be quiet about X and do Y", "quiet please", "mute the mac 5m", "chatty maybe", "hush 5 days", `mute${"!".repeat(30_000)}x`]) {
    expect(parseChatterCommand(t), t).toBeUndefined();
  }
});

test("state: missing row is off; on clears a mute; it survives a reopen", () => {
  const dbPath = db();
  const a = makeChatter({ dbPath, surface: "discord" });
  expect(a.get("s1")).toEqual({ enabled: false });
  a.setEnabled("s1", true);
  a.setMutedUntil("s1", 123);
  expect(makeChatter({ dbPath, surface: "discord" }).get("s1")).toEqual({ enabled: true, mutedUntil: 123 });
  expect(makeChatter({ dbPath, surface: "teams" }).get("s1")).toEqual({ enabled: false });
  a.setEnabled("s1", true);
  expect(a.get("s1")).toEqual({ enabled: true });
  a.setEnabled("s1", false);
  expect(a.get("s1")).toEqual({ enabled: false });
});
