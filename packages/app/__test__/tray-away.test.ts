import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dbFile, makeAway, outboxDir, runAwayCommand } from "@bean/core";
import { awaySurfaces, setTrayAway, trayAwayOn } from "../src/chatops-tray-menu.js";

const beanHome = (): string => mkdtempSync(join(tmpdir(), "bean-tray-away-"));

test("the tray checkbox reads a DM change on the next open, per surface", () => {
  const dir = beanHome();
  expect(trayAwayOn(dir, "discord")).toBe(false);
  runAwayCommand(makeAway({ dbPath: dbFile(dir), surface: "discord" }), { kind: "on" }, 1_000);
  expect(trayAwayOn(dir, "discord")).toBe(true);
  expect(trayAwayOn(dir, "teams")).toBe(false);
});

test("the avatar's away pills list each surface with away on, in tray order", async () => {
  const dir = beanHome();
  expect(awaySurfaces(dir)).toEqual([]);
  await setTrayAway(dir, "teams", true, 1_000);
  expect(awaySurfaces(dir)).toEqual(["teams"]);
  runAwayCommand(makeAway({ dbPath: dbFile(dir), surface: "discord" }), { kind: "on" }, 2_000);
  expect(awaySurfaces(dir)).toEqual(["discord", "teams"]);
  await setTrayAway(dir, "teams", false);
  expect(awaySurfaces(dir)).toEqual(["discord"]);
});

test("on sets away with no reason, and leaves a period already on (and its reason) alone", async () => {
  const dir = beanHome();
  await setTrayAway(dir, "teams", true, 5_000);
  expect(makeAway({ dbPath: dbFile(dir), surface: "teams" }).get()).toEqual({ on: true, since: 5_000 });

  runAwayCommand(makeAway({ dbPath: dbFile(dir), surface: "discord" }), { kind: "on", reason: "dentist" }, 1_000);
  await setTrayAway(dir, "discord", true, 9_000);
  expect(makeAway({ dbPath: dbFile(dir), surface: "discord" }).get()).toEqual({ on: true, since: 1_000, reason: "dentist" });
});

test("off closes the period and queues its summary for the owner's DM only", async () => {
  const dir = beanHome();
  const away = makeAway({ dbPath: dbFile(dir), surface: "discord" });
  await setTrayAway(dir, "discord", true, 1_000);
  away.capture({ conversationId: "c1", messageId: "m1", senderId: "u1", senderName: "Ana", text: "ping", at: 2_000, awaySince: 1_000 });

  await setTrayAway(dir, "discord", false);
  expect(away.get()).toEqual({ on: false });
  const files = readdirSync(outboxDir(dir));
  expect(files).toHaveLength(1);
  const msg = JSON.parse(readFileSync(join(outboxDir(dir), files[0]!), "utf8")) as Record<string, unknown>;
  expect(msg.transport).toBe("discord");
  expect(msg.channel).toBeUndefined();
  expect(msg.userId).toBeUndefined();
  expect(msg.body).toContain("Ana: `ping`");

  // Already off (say, ended from the DM since the menu opened): nothing more is queued.
  await setTrayAway(dir, "discord", false);
  expect(readdirSync(outboxDir(dir))).toHaveLength(1);
});
