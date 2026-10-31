import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deliveredAppend, loadTeamsConfig, teamsConfigFile } from "../src/teams-config.js";

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

const bare = { id: "19:abc@thread.tacv2", conversationType: "channel" };

test.each([false, true])("bare-channel digest saves under the post-thread key only (context=%s)", (context) => {
  const msg = { channel: bare.id, context, body: "body" };
  expect(deliveredAppend(msg, bare, "**T**\n\nbody", "1700")).toEqual({ key: `${bare.id};messageid=1700`, body: "**T**\n\nbody" });
});

test("bare-channel post with no returned id skips the save", () => {
  expect(deliveredAppend({ channel: bare.id, context: true, body: "b" }, bare, "b", undefined)).toBe("missing-id");
});

test("bare-channel notice saves its model-facing body, not the display text", () => {
  expect(deliveredAppend({ channel: bare.id, displayBody: "short", body: "full" }, bare, "short", "9"))
    .toEqual({ key: `${bare.id};messageid=9`, body: "full" });
});

test("existing-thread target keeps its own key", () => {
  const thread = { ...bare, id: `${bare.id};messageid=5` };
  expect(deliveredAppend({ channel: thread.id, context: true, body: "b" }, thread, "x", "7")).toEqual({ key: thread.id, body: "b" });
  expect(deliveredAppend({ channel: thread.id, displayBody: "s", body: "b" }, thread, "s", "7")).toEqual({ key: thread.id, body: "b" });
  expect(deliveredAppend({ channel: thread.id, body: "b" }, thread, "b", "7")).toBeNull();
});

test("DMs and group chats are unchanged", () => {
  const dm = { id: "a:1", conversationType: "personal" };
  expect(deliveredAppend({ body: "b" }, dm, "b", "7")).toBeNull();
  expect(deliveredAppend({ context: true, body: "b" }, dm, "b", "7")).toEqual({ key: "a:1", body: "b" });
  const group = { id: "19:g@thread.v2", conversationType: "groupChat" };
  expect(deliveredAppend({ channel: group.id, body: "b" }, group, "b", "7")).toBeNull();
});
