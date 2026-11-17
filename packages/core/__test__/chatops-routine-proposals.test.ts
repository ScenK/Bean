import { describe, expect, test } from "vitest";
import {
  describeSchedule, describeStep, parseRoutineCommand, routineCardInput, RoutineProposalStore, routineListText,
} from "../src/chatops/routine-proposals.js";
import type { Routine } from "../src/routine-store.js";
import type { Project } from "../src/types.js";

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

test("parseRoutineCommand strips quotes in linear time", () => {
  const t = performance.now();
  expect(parseRoutineCommand("enable " + '"'.repeat(200_000) + "x")).toEqual({ kind: "enable", name: "x" });
  expect(parseRoutineCommand("enable " + "x" + '"'.repeat(200_000) + "y")).toEqual({ kind: "enable", name: "x" + '"'.repeat(200_000) + "y" });
  expect(performance.now() - t).toBeLessThan(500);
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

test("the drafting channel reads as This channel/This chat; other Teams channels show the plain id (#320)", () => {
  const store = new RoutineProposalStore();
  const card = (chatops: Routine["sinks"]["chatops"], channelId?: string) => routineCardInput(
    store.add({ proposal: { routine: { ...base, sinks: { chatops } }, updating: false }, conversationId: "c", proposedBy: "Scen", ...(channelId ? { channelId } : {}) }),
    [], "Scen",
  ).sinks;
  expect(card([{ transport: "discord", channel: "42" }, { transport: "discord", channel: "7" }], "42")).toEqual(["This channel", "<#7>"]);
  expect(card([{ transport: "teams", channel: "19:a" }, { transport: "teams", channel: "19:b" }], "19:a")).toEqual(["This chat", "19:b"]);
});

test("a stepped day-of-month gets a resets-monthly warning; weekday lists don't", () => {
  const store = new RoutineProposalStore();
  const warnings = (cron: string) => routineCardInput(
    store.add({ proposal: { routine: { ...base, cron }, updating: false }, conversationId: "c", proposedBy: "Scen" }), [], "Scen",
  ).warnings;
  expect(warnings("0 9 */3 * *")?.[0]).toMatch(/restarts every month on the 1st/);
  expect(warnings("0 9 1-31/2 * *")).toHaveLength(1);
  expect(warnings("0 9 * * 1,4")).toBeUndefined();
  expect(warnings("*/15 * * * *")).toBeUndefined();
});

test("describeStep renders a skill-less delegate step without undefined", () => {
  expect(describeStep({ kind: "delegate", instruction: "fix it" }, 0)).toBe("1. agent: fix it");
  expect(describeStep({ kind: "delegate", project: "/code/bean", instruction: "fix it" }, 1)).toBe("2. agent (in bean): fix it");
  expect(describeStep({ kind: "delegate", skill: "review", project: "/code/bean", instruction: "go" }, 2)).toBe("3. agent (review in bean): go");
});

describe("routineListText sections (#885)", () => {
  const delegate = (project: string, skill = "fix"): Routine["steps"][number] => ({ kind: "delegate", skill, project, instruction: "go" });
  const sprout = (name: string, over: Partial<Routine>): Routine => ({ ...base, name, ...over });
  const projects: Project[] = [
    { name: "Zed", path: "/w/zed" },
    { name: "App", path: "/w/app" },
    { name: "Ops @everyone *x*", path: "/w/ops" },
  ];
  const skills = new Set(["fix"]);
  const routines = [
    sprout("in-app", { steps: [delegate("/w/app/sub")] }),
    sprout("listed", { projects: ["/w/zed", "/w/app"] }),
    sprout("chatty", {}),
    sprout("stray", { enabled: false, steps: [delegate("/Users/scen/secret/repo")] }),
    sprout("ops-run", { steps: [delegate("/w/ops", "gone")] }),
    sprout("too-wide", { steps: [delegate("/w")] }),
  ];
  const text = routineListText(routines, projects, skills, "UTC");
  const headings = text.split("\n").filter((l) => l.startsWith("**"));

  test("headings follow the desktop order: Needs fixing, projects A–Z, Scratch", () => {
    expect(headings).toEqual(["**Needs fixing**", "**App**", "**Ops @\u200beveryone \\*x\\***", "**Zed**", "**Scratch**"]);
  });

  test("each sprout once: first project in registry order with also, folder problems under Needs fixing", () => {
    const section = (h: string): string[] => {
      const lines = text.split("\n");
      const rest = lines.slice(lines.indexOf(h) + 1);
      return rest.slice(0, rest.findIndex((l) => !l.startsWith("•")));
    };
    expect(section("**Zed**")).toEqual(["• **listed** — on — Weekdays at 7:00 AM · also App"]);
    expect(section("**App**")).toEqual(["• **in-app** — on — Weekdays at 7:00 AM"]);
    expect(section("**Scratch**")).toEqual(["• **chatty** — on — Weekdays at 7:00 AM"]);
    expect(section("**Needs fixing**")).toEqual([
      "• **stray** — on demand — Weekdays at 7:00 AM · ⚠ step 1 folder repo isn't a registered project",
      "• **too-wide** — on — Weekdays at 7:00 AM · ⚠ step 1 folder w holds several projects",
    ]);
    expect(text).toContain("• **ops-run** — on — Weekdays at 7:00 AM · ⚠ step 1 skill gone not found");
  });

  test("no absolute path and no live mention", () => {
    expect(text).not.toMatch(/\/(Users|w)\b/);
    expect(text).not.toMatch(/@everyone/);
    expect(text).toMatch(/Times are UTC\. `enable <name>` \/ `disable <name>` to switch one\.$/);
  });

  test("no projects: everything under Scratch", () => {
    expect(routineListText([base], [], skills, "UTC").split("\n").slice(0, 2)).toEqual(["**Scratch**", "• **r** — on — Weekdays at 7:00 AM"]);
  });

  test("a disabled schedule sprout reads on demand; a disabled watch stays off", () => {
    const { cron: _cron, ...noCron } = base;
    const watch: Routine = { ...noCron, name: "w", enabled: false, watch: { kind: "feed", url: "https://x.test/feed" } };
    const lines = routineListText([{ ...base, enabled: false }, watch], [], skills, "UTC").split("\n");
    expect(lines[1]).toMatch(/^• \*\*r\*\* — on demand — /);
    expect(lines[2]).toMatch(/^• \*\*w\*\* — off — /);
  });
});
