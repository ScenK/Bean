import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AmbientStore, ambientSpeakers, clearAlias, destinationLabel, forgetDestination, listDestinations, matchDestination,
  recordDestination, retargetAlias, setAlias, type OutboxMessage, type Routine,
} from "@bean/core";
import { aliasUsers, buildDestinationHandlers, buildSendHandlers } from "../src/destinations.js";

const sprout = (name: string, alias?: string): Routine => ({
  name, enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "x" }],
  sinks: { chatops: [{ transport: "discord", ...(alias ? { alias } : {}) }] },
});

function setup(routines: Routine[] = [], saved: Routine[] = []) {
  const file = join(mkdtempSync(join(tmpdir(), "bean-app-dest-")), "bean.db");
  recordDestination(file, { surface: "discord", conversationId: "d1", kind: "channel", platformName: "ops", parentName: "Guild" });
  recordDestination(file, { surface: "discord", conversationId: "d2", kind: "channel", platformName: "ops-2", parentName: "Guild" });
  recordDestination(file, { surface: "teams", conversationId: "19:a_b@unq.gbl.spaces", kind: "group" });
  const h = buildDestinationHandlers({
    dbFile: file,
    loadRoutines: async () => routines,
    saveRoutine: async (r) => { saved.push(r); },
    owners: async () => [{ ownerName: "Scen" }],
    listDestinations: (f) => listDestinations(f),
    destinationLabel,
    ambientSpeakers: (f, id) => ambientSpeakers(f, id),
    setAlias, clearAlias, retargetAlias,
  });
  return { file, h };
}

test("aliasUsers lists the sprouts whose chat sinks name the alias", () => {
  expect(aliasUsers([sprout("a", "Ops"), sprout("b"), sprout("c", "Ops")])("Ops")).toEqual(["a", "c"]);
  expect(aliasUsers([sprout("a", "Ops")])("Other")).toEqual([]);
});

test("list carries labels, sprout references and a 1:1 hint from ambient speakers (owner excluded)", async () => {
  const { file, h } = setup([sprout("nightly", "Ops room")]);
  const ambient = new AmbientStore(file);
  ambient.append("19:a_b@unq.gbl.spaces", { fromName: "Scen", text: "hi", at: 2 });
  ambient.append("19:a_b@unq.gbl.spaces", { fromName: "Ana", text: "hey", at: 1 });
  expect(await h.name("discord", "d1", "Ops room")).toEqual({ ok: true });
  const rows = await h.list();
  expect(rows.find((r) => r.conversationId === "d1")).toMatchObject({ alias: "Ops room", label: "Ops room", usedBy: ["nightly"] });
  expect(rows.find((r) => r.conversationId === "d2")).toMatchObject({ label: "ops-2", usedBy: [] });
  const oneToOne = rows.find((r) => r.surface === "teams");
  expect(oneToOne).toMatchObject({ hint: "1:1 · Ana", usedBy: [] });
  expect(oneToOne?.label).toBeUndefined();
});

test("rename and clear of an alias a sprout references are refused; an unreferenced one works", async () => {
  const { h } = setup([sprout("nightly", "Ops room")]);
  expect(await h.name("discord", "d1", "Ops room")).toEqual({ ok: true });
  expect(await h.name("discord", "d1", "Renamed")).toMatchObject({ ok: false, error: expect.stringContaining("nightly") });
  expect(await h.clear("discord", "d1")).toMatchObject({ ok: false, error: expect.stringContaining("nightly") });
  expect(await h.name("discord", "d2", "Spare")).toEqual({ ok: true });
  expect(await h.clear("discord", "d2")).toEqual({ ok: true });
});

test("retarget moves a referenced alias within a platform but refuses a cross-platform move", async () => {
  const { file, h } = setup([sprout("nightly", "Ops room")]);
  await h.name("discord", "d1", "Ops room");
  expect(await h.retarget("Ops room", "teams", "19:a_b@unq.gbl.spaces")).toMatchObject({ ok: false, error: expect.stringContaining("same platform") });
  expect(await h.retarget("Ops room", "discord", "d2")).toEqual({ ok: true });
  expect(listDestinations(file).find((r) => r.alias === "Ops room")?.conversationId).toBe("d2");
});

test("malformed renderer input is rejected before it reaches the store", async () => {
  const { h } = setup();
  await expect(h.name("slack", "d1", "x")).rejects.toThrow("malformed");
  await expect(h.clear("discord", 5)).rejects.toThrow("malformed");
  await expect(h.retarget(7, "discord", "d1")).rejects.toThrow("malformed");
});

test("Name it on a raw id names the conversation and rewrites that id to the alias in every sprout using it", async () => {
  const raw = (name: string, channel: string): Routine => ({
    name, enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "x" }],
    sinks: { note: true, chatops: [{ transport: "discord" }, { transport: "discord", channel }, { transport: "teams", channel }] },
  });
  const saved: Routine[] = [];
  const { file, h } = setup([raw("a", "d1"), raw("b", "d2"), raw("c", "d1")], saved);
  expect(await h.nameRaw("discord", "d1", "  Ops   room ")).toEqual({ ok: true, alias: "Ops room", sprouts: ["a", "c"] });
  expect(listDestinations(file).find((r) => r.conversationId === "d1")?.alias).toBe("Ops room");
  expect(saved.map((r) => r.name)).toEqual(["a", "c"]);
  // Only the matching platform's raw id changes; the DM and the Teams sink stay as they were.
  expect(saved[0]?.sinks).toEqual({ note: true, chatops: [
    { transport: "discord" }, { transport: "discord", alias: "Ops room" }, { transport: "teams", channel: "d1" },
  ] });
  expect(await h.nameRaw("discord", "nope", "X")).toMatchObject({ ok: false });
});

function sendSetup() {
  const file = join(mkdtempSync(join(tmpdir(), "bean-app-send-")), "bean.db");
  recordDestination(file, { surface: "discord", conversationId: "d1", kind: "channel", platformName: "deploys", parentName: "Guild" });
  recordDestination(file, { surface: "discord", conversationId: "d2", kind: "channel", platformName: "general", parentName: "Guild" });
  recordDestination(file, { surface: "teams", conversationId: "t1", kind: "group", platformName: "Family" });
  recordDestination(file, { surface: "teams", conversationId: "19:x_y@unq.gbl.spaces", kind: "group" }); // unlabelled
  const queued: Array<Pick<OutboxMessage, "transport" | "channel" | "body">> = [];
  let n = 0;
  const h = buildSendHandlers({
    dbFile: file, listDestinations: (f) => listDestinations(f), destinationLabel, matchDestination,
    enqueue: async (m) => { queued.push(m); }, newId: () => `p${++n}`,
  });
  return { file, h, queued };
}

test("propose offers every labelled row, candidates first, and pre-picks a typo's confident match", () => {
  const { h } = sendSetup();
  const card = h.propose("deplys", "Deploy done.");
  expect(card.options[0]?.label).toBe("deploys");
  expect(card.options.map((o) => o.label).sort()).toEqual(["Family", "deploys", "general"]);
  const picked = card.options.find((o) => o.id === card.pick);
  expect(picked).toMatchObject({ surface: "discord", label: "deploys", detail: "deploys · Guild · channel" });
  expect(h.propose("zzzz", "x").pick).toBeUndefined();
});

test("send refuses no pick, an unknown option and an unknown card; the queued message has the resolved id and exact body", async () => {
  const { h, queued } = sendSetup();
  const card = h.propose("Family", "  Dinner at 7.\n");
  expect(await h.send(card.id, "")).toMatchObject({ ok: false, error: expect.stringContaining("Pick") });
  expect(await h.send(card.id, "99")).toMatchObject({ ok: false });
  expect(await h.send("nope", card.pick)).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
  expect(queued).toEqual([]);
  expect(await h.send(card.id, card.pick)).toEqual({ ok: true, label: "Family" });
  expect(queued).toEqual([{ transport: "teams", channel: "t1", body: "  Dinner at 7.\n" }]);
  // One-shot: the same card can't post twice.
  expect(await h.send(card.id, card.pick)).toMatchObject({ ok: false });
  expect(queued).toHaveLength(1);
});

test("send re-resolves the row: a conversation forgotten since the card was shown is refused", async () => {
  const { file, h, queued } = sendSetup();
  const card = h.propose("general", "hi");
  forgetDestination(file, { surface: "discord", conversationId: "d2" });
  expect(await h.send(card.id, card.pick)).toMatchObject({ ok: false, error: expect.stringContaining("isn't known") });
  expect(queued).toEqual([]);
});
