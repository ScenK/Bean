import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadTeamsConfig, ownerDmRefs, teamsConfigFile } from "../src/teams-config.js";

test("teamsConfigFile joins dir with teams.json", () => {
  expect(teamsConfigFile("/home/x/.bean")).toBe(join("/home/x/.bean", "teams.json"));
});

test("loads a valid config and defaults port to 3978", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw", tenantId: "tid" }), "utf8");
  expect(await loadTeamsConfig(file)).toEqual({ botAppId: "id", botAppPassword: "pw", tenantId: "tid", port: 3978, allowGuestDms: false });
});

test("missing file throws with a setup hint", async () => {
  await expect(loadTeamsConfig("/nope/teams.json")).rejects.toThrow(/Teams config missing/);
});

test("incomplete config throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id" }), "utf8");
  await expect(loadTeamsConfig(file)).rejects.toThrow(/needs botAppId, botAppPassword, and tenantId/);
});

test("config missing tenantId throws (Azure Bot no longer offers Multi Tenant)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw" }), "utf8");
  await expect(loadTeamsConfig(file)).rejects.toThrow(/needs botAppId, botAppPassword, and tenantId/);
});

test("optional ownerId is parsed when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw", tenantId: "tid", ownerId: "29:owner" }), "utf8");
  expect((await loadTeamsConfig(file)).ownerId).toBe("29:owner");
});

test("outbox DMs reach only the owner's personal conversation, not a coworker's", () => {
  const owner = { conversation: { id: "a", conversationType: "personal" }, user: { id: "29:owner", aadObjectId: "aad-owner" } };
  const coworker = { conversation: { id: "b", conversationType: "personal" }, user: { id: "29:cow", aadObjectId: "aad-cow" } };
  const channel = { conversation: { id: "c", conversationType: "channel" }, user: { id: "29:owner" } };
  const refs = { a: owner, b: coworker, c: channel };
  expect(ownerDmRefs(refs, "29:owner")).toEqual([owner]);
  expect(ownerDmRefs(refs, "aad-owner")).toEqual([owner]);
  expect(ownerDmRefs(refs, undefined)).toEqual([]);
});
