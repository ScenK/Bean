import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeDb } from "../src/db.js";
import {
  clearAlias, destinationLabel, forgetDestination, listDestinations, matchDestination, recordDestination, retargetAlias, setAlias,
  type Destination,
} from "../src/destinations.js";

const files: string[] = [];
const freshDb = (): string => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-dest-")), "bean.db");
  files.push(file);
  return file;
};
afterEach(() => { for (const f of files.splice(0)) closeDb(f); });

const at = (iso: string) => () => new Date(iso);
const unused = () => [];
const row = (conversationId: string, extra: Partial<Destination> = {}): Destination =>
  ({ surface: "discord", conversationId, kind: "channel", lastSeen: "2026-11-05T00:00:00.000Z", ...extra });

test("upsert keeps an existing alias and a known name when a sighting has none", () => {
  const file = freshDb();
  recordDestination(file, { surface: "discord", conversationId: "1", kind: "channel", platformName: "ops", parentName: "Guild" });
  expect(setAlias(file, { surface: "discord", conversationId: "1" }, "Ops room", unused)).toEqual({ ok: true });
  expect(recordDestination(file, { surface: "discord", conversationId: "1", kind: "channel", platformName: "ops-renamed" })).toBe(true);
  expect(listDestinations(file)).toMatchObject([{ alias: "Ops room", platformName: "ops-renamed", parentName: "Guild" }]);
});

test("an unchanged sighting under an hour old is skipped; after an hour or a rename it writes", () => {
  const file = freshDb();
  const seen = { surface: "teams", conversationId: "19:a", kind: "group", platformName: "Team chat" } as const;
  expect(recordDestination(file, seen, at("2026-11-05T10:00:00Z"))).toBe(true);
  expect(recordDestination(file, seen, at("2026-11-05T10:30:00Z"))).toBe(false);
  expect(recordDestination(file, { ...seen, platformName: undefined }, at("2026-11-05T10:31:00Z"))).toBe(false);
  expect(listDestinations(file)[0]?.lastSeen).toBe("2026-11-05T10:00:00.000Z");
  expect(recordDestination(file, { ...seen, platformName: "Renamed" }, at("2026-11-05T10:40:00Z"))).toBe(true);
  expect(recordDestination(file, { ...seen, platformName: "Renamed" }, at("2026-11-05T11:41:00Z"))).toBe(true);
  expect(listDestinations(file, "teams")[0]?.lastSeen).toBe("2026-11-05T11:41:00.000Z");
  expect(listDestinations(file, "discord")).toEqual([]);
});

test("alias uniqueness is checked against other rows' aliases, names and labels", () => {
  const file = freshDb();
  recordDestination(file, { surface: "discord", conversationId: "1", kind: "channel", platformName: "#general" });
  recordDestination(file, { surface: "teams", conversationId: "2", kind: "channel", platformName: "Standup" });
  const k1 = { surface: "discord", conversationId: "1" } as const;
  expect(setAlias(file, { surface: "teams", conversationId: "2" }, "General", unused).ok).toBe(false);
  expect(setAlias(file, k1, "standup!", unused).ok).toBe(false);
  expect(setAlias(file, k1, "Ops", unused).ok).toBe(true);
  expect(setAlias(file, { surface: "teams", conversationId: "2" }, "ops", unused).ok).toBe(false);
  expect(setAlias(file, k1, "!!!", unused).ok).toBe(false);
  expect(setAlias(file, { surface: "discord", conversationId: "nope" }, "x", unused).ok).toBe(false);
});

test("two #general rows get distinct labels: parent, then a short id; nameless rows have none", () => {
  const rows = [
    row("111", { platformName: "#general", parentName: "Ops" }),
    row("222", { platformName: "#general", parentName: "Dev" }),
    row("333", { platformName: "#general", parentName: "Dev" }),
    row("444"),
  ];
  const labels = rows.map((r) => destinationLabel(r, rows));
  expect(labels).toEqual(["#general (Ops)", "#general (Dev, 222)", "#general (Dev, 333)", undefined]);
  const aliased = [row("1", { alias: "general" }), row("2", { platformName: "#General", parentName: "G" })];
  expect(aliased.map((r) => destinationLabel(r, aliased))).toEqual(["general", "#General (G)"]);
});

test("retarget moves the alias within a surface only; a referenced alias can't be renamed or cleared", () => {
  const file = freshDb();
  for (const [surface, id] of [["discord", "1"], ["discord", "2"], ["teams", "3"]] as const) {
    recordDestination(file, { surface, conversationId: id, kind: "channel", platformName: `c${id}` });
  }
  const k1 = { surface: "discord", conversationId: "1" } as const;
  const k2 = { surface: "discord", conversationId: "2" } as const;
  expect(setAlias(file, k1, "ops", unused).ok).toBe(true);
  const inUse = (a: string) => (a === "ops" ? ["Daily digest"] : []);
  expect(setAlias(file, k1, "ops2", inUse)).toEqual({ ok: false, error: expect.stringContaining("Daily digest") });
  expect(clearAlias(file, k1, inUse).ok).toBe(false);
  expect(retargetAlias(file, "ops", { surface: "teams", conversationId: "3" }, inUse).ok).toBe(false);
  expect(retargetAlias(file, "ops", k2, inUse)).toEqual({ ok: true });
  expect(listDestinations(file, "discord").map((d) => [d.conversationId, d.alias]).sort()).toEqual([["1", undefined], ["2", "ops"]]);
  expect(clearAlias(file, k2, unused)).toEqual({ ok: true });
  expect(listDestinations(file).every((d) => !d.alias)).toBe(true);
});

test("retarget refuses to overwrite the target's referenced alias", () => {
  const file = freshDb();
  for (const id of ["1", "2"]) recordDestination(file, { surface: "discord", conversationId: id, kind: "channel" });
  setAlias(file, { surface: "discord", conversationId: "1" }, "a", unused);
  setAlias(file, { surface: "discord", conversationId: "2" }, "b", unused);
  expect(retargetAlias(file, "a", { surface: "discord", conversationId: "2" }, (x) => (x === "b" ? ["S"] : [])).ok).toBe(false);
  expect(retargetAlias(file, "missing", { surface: "discord", conversationId: "2" }, unused).ok).toBe(false);
});

test("matcher: typo, unique token, ties and scope", () => {
  const greatest = row("1", { platformName: "the greatest ops channel" });
  const general = row("2", { platformName: "#general" });
  const rows = [greatest, general, row("3")];
  expect(matchDestination("the greataets ops", rows).pick).toBe(greatest);
  expect(matchDestination("ops", rows).pick).toBe(greatest);
  expect(matchDestination("GENERAL", rows).pick).toBe(general);
  expect(matchDestination("zzz", rows)).toEqual({ candidates: [] });
  expect(matchDestination("", rows)).toEqual({ candidates: [] });

  const a = row("a", { platformName: "deploy-a" });
  const b = row("b", { platformName: "deploy-b" });
  const tie = matchDestination("deploi", [a, b]);
  expect(tie.pick).toBeUndefined();
  expect(tie.candidates).toEqual(expect.arrayContaining([a, b]));
  const twoGeneral = [general, row("9", { platformName: "#general", parentName: "Dev" })];
  expect(matchDestination("#general", twoGeneral).pick).toBeUndefined();
  expect(matchDestination("ops", [general]).candidates).toEqual([]);
  expect(matchDestination("ops", [general, a]).candidates).not.toContain(greatest);
});

test("forget drops an un-aliased row but keeps an aliased one, name and all", () => {
  const file = freshDb();
  for (const id of ["1", "2"]) recordDestination(file, { surface: "discord", conversationId: id, kind: "channel", platformName: `c${id}` });
  setAlias(file, { surface: "discord", conversationId: "1" }, "ops", unused);
  forgetDestination(file, { surface: "discord", conversationId: "1" });
  forgetDestination(file, { surface: "discord", conversationId: "2" });
  expect(listDestinations(file)).toMatchObject([{ conversationId: "1", alias: "ops", platformName: "c1" }]);
});
