import { expect, test } from "vitest";
import {
  describeSchedule, parseRoutineCommand, routineCardInput, RoutineProposalStore,
} from "../src/chatops/routine-proposals.js";
import type { Routine } from "../src/routine-store.js";

const base: Routine = { name: "r", enabled: true, cron: "0 7 * * 1-5", steps: [{ kind: "chat", instruction: "hi" }], sinks: {} };

test("describeSchedule reads common crons in plain English with the TZ, else shows the cron", () => {
  expect(describeSchedule(base, "America/Toronto")).toBe("Weekdays at 7:00 AM (America/Toronto)");
  expect(describeSchedule({ ...base, cron: "30 18 * * *" }, "UTC")).toBe("Every day at 6:30 PM (UTC)");
  expect(describeSchedule({ ...base, cron: "0 12 * * 0,6" }, "UTC")).toBe("Weekends at 12:00 PM (UTC)");
  expect(describeSchedule({ ...base, cron: "0 0 * * 1,3" }, "UTC")).toBe("Mondays, Wednesdays at 12:00 AM (UTC)");
  expect(describeSchedule({ ...base, cron: "*/15 * * * *" }, "UTC")).toBe("cron `*/15 * * * *` (UTC)");
});

test("parseRoutineCommand", () => {
  expect(parseRoutineCommand("routines")).toEqual({ kind: "list" });
  expect(parseRoutineCommand("/Routines")).toEqual({ kind: "list" });
  expect(parseRoutineCommand("disable `mia-summary`")).toEqual({ kind: "disable", name: "mia-summary" });
  expect(parseRoutineCommand("Enable morning")).toEqual({ kind: "enable", name: "morning" });
  expect(parseRoutineCommand("enable")).toBeUndefined();
  expect(parseRoutineCommand("what routines do I have")).toBeUndefined();
});

test("card input names DM recipients and notes a shared todo digest", () => {
  const store = new RoutineProposalStore();
  const routine: Routine = {
    ...base, todoDriven: true,
    sinks: { chatops: [{ transport: "discord", user: "mia" }, { transport: "discord", channel: "42" }, { transport: "discord" }] },
  };
  const p = store.add({ proposal: { routine, updating: false }, conversationId: "c", proposedBy: "Scen" });
  const card = routineCardInput(p, [{ id: "mia", name: "Mia" }], "Scen");
  expect(card.sinks).toEqual(["DM Mia", "<#42>", "DM Scen"]);
  expect(card.steps).toEqual(["1. chat: hi"]);
  expect(card.todoNote).toMatch(/one digest/);
  const invalid = store.add({ proposal: { routine: { ...routine, cron: "x" }, updating: false, problem: "bad cron" }, conversationId: "c", proposedBy: "Scen" });
  expect(routineCardInput(invalid, [], "Scen")).toMatchObject({ problem: "bad cron", steps: [] });
});

test("the store expires drafts and claims once", () => {
  let now = 0;
  const store = new RoutineProposalStore(() => now);
  const p = store.add({ proposal: { routine: base, updating: false }, conversationId: "c", proposedBy: "x" });
  expect(store.get(p.id)).toBeDefined();
  expect(store.claim(p.id)).toBeDefined();
  expect(store.claim(p.id)).toBeUndefined();
  const q = store.add({ proposal: { routine: base, updating: false }, conversationId: "c", proposedBy: "x" });
  now = 11 * 60_000;
  expect(store.get(q.id)).toBeUndefined();
});
