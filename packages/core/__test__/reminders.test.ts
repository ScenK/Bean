import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dueReminders, loadReminders, saveReminders, type Reminder } from "../src/reminders.js";

const r = (over: Partial<Reminder> = {}): Reminder => ({
  id: "1", text: "stretch", at: "2026-07-03T10:00:00.000Z", ...over,
});

test("save/load round-trips reminders and creates the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  const file = join(dir, "nested", "reminders.json");
  const reminders = [r(), r({ id: "2", firedAt: "2026-07-03T10:00:01.000Z" })];
  await saveReminders(file, reminders);
  expect(await loadReminders(file)).toEqual(reminders);
});

test("missing or invalid file degrades to []", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  expect(await loadReminders(join(dir, "nope.json"))).toEqual([]);
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{not json", "utf8");
  expect(await loadReminders(bad)).toEqual([]);
});

test("invalid entries are filtered out on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  const file = join(dir, "reminders.json");
  await writeFile(file, JSON.stringify([r(), { id: "x" }, { id: "y", text: "t", at: "not-a-date" }]), "utf8");
  expect(await loadReminders(file)).toEqual([r()]);
});

test("dueReminders returns unfired past-due reminders only", () => {
  const now = new Date("2026-07-03T10:00:00.000Z");
  const due = r({ id: "due", at: "2026-07-03T09:59:00.000Z" });
  const exact = r({ id: "exact", at: "2026-07-03T10:00:00.000Z" });
  const future = r({ id: "future", at: "2026-07-03T10:01:00.000Z" });
  const fired = r({ id: "fired", at: "2026-07-03T09:00:00.000Z", firedAt: "2026-07-03T09:00:05.000Z" });
  expect(dueReminders([due, exact, future, fired], now)).toEqual([due, exact]);
});

test("updateReminders: concurrent sets during a claim lose nothing and fire nothing twice", async () => {
  const { updateReminders, claimDueReminders } = await import("../src/reminders.js");
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  const file = join(dir, "reminders.json");
  await saveReminders(file, [r({ id: "due" })]);
  const now = new Date("2026-07-03T11:00:00.000Z");
  const adds = Array.from({ length: 10 }, (_, i) => updateReminders(file, (all) => { all.push(r({ id: `n${i}`, at: "2026-07-04T00:00:00.000Z" })); }));
  const [first, second] = await Promise.all([claimDueReminders(file, now), claimDueReminders(file, now), ...adds]);
  expect([...first, ...second].map((x) => x.id)).toEqual(["due"]);
  const all = await loadReminders(file);
  expect(all).toHaveLength(11);
  expect(all.find((x) => x.id === "due")?.firedAt).toBe(now.toISOString());
});

test("cancelReminder: own only unless owner, idempotent, never a fired one", async () => {
  const { cancelReminder } = await import("../src/reminders.js");
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  const file = join(dir, "reminders.json");
  await saveReminders(file, [r({ id: "a", setBy: "mia" }), r({ id: "f", setBy: "mia", firedAt: "2026-07-03T10:00:01.000Z" })]);
  expect(await cancelReminder(file, "a", "max")).toEqual({ outcome: "forbidden" });
  expect(await cancelReminder(file, "f", "mia")).toEqual({ outcome: "missing" });
  expect(await cancelReminder(file, "a")).toEqual({ outcome: "cancelled", text: "stretch" });
  expect(await cancelReminder(file, "a")).toEqual({ outcome: "missing" });
});

test("fireDueReminders: targeted → outbox (DM or channel), untargeted → desktop, malformed fails loudly", async () => {
  const { fireDueReminders } = await import("../src/reminders.js");
  const dir = await mkdtemp(join(tmpdir(), "bean-rem-"));
  const file = join(dir, "reminders.json");
  await writeFile(file, JSON.stringify([
    r({ id: "desk" }),
    r({ id: "dm", target: { transport: "discord", userId: "mia" } }),
    r({ id: "chan", target: { transport: "discord", channelId: "c1" } }),
    { ...r({ id: "bad" }), target: { transport: "discord" } },
    { ...r({ id: "both" }), target: { transport: "discord", userId: "mia", channelId: "c1" } },
    { ...r({ id: "null" }), target: null },
    r({ id: "teams", target: { transport: "teams", channelId: "19:ch@thread.tacv2;messageid=1" } }),
    { ...r({ id: "teamsUser" }), target: { transport: "teams", userId: "mia" } },
    { ...r({ id: "teamsBoth" }), target: { transport: "teams", userId: "mia", channelId: "c1" } },
    { ...r({ id: "teamsEmpty" }), target: { transport: "teams", channelId: "" } },
    { ...r({ id: "slack" }), target: { transport: "slack", channelId: "c1" } },
  ]), "utf8");
  const desktop: string[] = [];
  const queued: object[] = [];
  const failed: string[] = [];
  await fireDueReminders(file, new Date("2026-07-03T11:00:00.000Z"), {
    untargeted: (x) => { desktop.push(x.id); },
    enqueue: async (m) => { queued.push(m); },
    failed: (x) => { failed.push(x.id); },
  });
  expect(desktop).toEqual(["desk"]);
  expect(queued).toEqual([
    { transport: "discord", title: "⏰ Reminder", body: "stretch", userId: "mia" },
    { transport: "discord", title: "⏰ Reminder", body: "stretch", channel: "c1" },
    { transport: "teams", title: "⏰ Reminder", body: "stretch", channel: "19:ch@thread.tacv2;messageid=1" },
  ]);
  expect(failed).toEqual(["bad", "both", "null", "teamsUser", "teamsBoth", "teamsEmpty", "slack"]);
  expect((await loadReminders(file)).every((x) => x.firedAt)).toBe(true);
});
