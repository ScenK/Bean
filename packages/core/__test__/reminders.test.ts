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
