import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AmbientStore, ambientSpeakers, clearAlias, destinationLabel, listDestinations, recordDestination, retargetAlias, setAlias,
  type Routine,
} from "@bean/core";
import { aliasUsers, buildDestinationHandlers } from "../src/destinations.js";

const sprout = (name: string, alias?: string): Routine => ({
  name, enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", instruction: "x" }],
  sinks: { chatops: [{ transport: "discord", ...(alias ? { alias } : {}) } as never] },
});

function setup(routines: Routine[] = []) {
  const file = join(mkdtempSync(join(tmpdir(), "bean-app-dest-")), "bean.db");
  recordDestination(file, { surface: "discord", conversationId: "d1", kind: "channel", platformName: "ops", parentName: "Guild" });
  recordDestination(file, { surface: "discord", conversationId: "d2", kind: "channel", platformName: "ops-2", parentName: "Guild" });
  recordDestination(file, { surface: "teams", conversationId: "19:a_b@unq.gbl.spaces", kind: "group" });
  const h = buildDestinationHandlers({
    dbFile: file,
    loadRoutines: async () => routines,
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
