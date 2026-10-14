import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discordConfigFile, loadDiscordConfig } from "../src/discord-config.js";

async function write(config: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bean-discord-"));
  const file = join(dir, "discord.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  return file;
}

test("discordConfigFile joins dir with discord.json", () => {
  expect(discordConfigFile("/home/x/.bean")).toBe(join("/home/x/.bean", "discord.json"));
});

test("loads a valid config", async () => {
  const file = await write({ botToken: "t", ownerId: "123", ownerName: "Scen", allowGuestDms: true });
  expect(await loadDiscordConfig(file)).toEqual({ botToken: "t", ownerId: "123", ownerName: "Scen", allowGuestDms: true, memberIds: [] });
});

test("memberIds are parsed and validated", async () => {
  expect((await loadDiscordConfig(await write({ botToken: "t", ownerId: "1", memberIds: ["22", "33"] }))).memberIds)
    .toEqual(["22", "33"]);
  await expect(loadDiscordConfig(await write({ botToken: "t", ownerId: "1", memberIds: "22" }))).rejects.toThrow(/memberIds/);
  await expect(loadDiscordConfig(await write({ botToken: "t", ownerId: "1", memberIds: ["bob"] }))).rejects.toThrow(/memberIds/);
});

test("optional guildId is parsed when present and omitted otherwise", async () => {
  expect(await loadDiscordConfig(await write({ botToken: "t", ownerId: "1", guildId: "999" })))
    .toEqual({ botToken: "t", ownerId: "1", allowGuestDms: false, memberIds: [], guildId: "999" });
  expect(await loadDiscordConfig(await write({ botToken: "t", ownerId: "1", guildId: "" })))
    .toEqual({ botToken: "t", ownerId: "1", allowGuestDms: false, memberIds: [] });
});

test("missing file throws with a setup hint", async () => {
  await expect(loadDiscordConfig("/nope/discord.json")).rejects.toThrow(/Discord config missing/);
});

test("invalid JSON throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-discord-"));
  const file = join(dir, "discord.json");
  await writeFile(file, "{nope", "utf8");
  await expect(loadDiscordConfig(file)).rejects.toThrow(/Discord config invalid/);
});

test("valid JSON that is not an object throws invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-discord-"));
  const file = join(dir, "discord.json");
  await writeFile(file, "null", "utf8");
  await expect(loadDiscordConfig(file)).rejects.toThrow(/Discord config invalid/);
});

test("empty botToken throws", async () => {
  await expect(loadDiscordConfig(await write({ botToken: "", ownerId: "1" }))).rejects.toThrow(/needs botToken/);
});

test("legacy allowedUserIds: one entry becomes the owner; several or none fail startup", async () => {
  expect(await loadDiscordConfig(await write({ botToken: "t", allowedUserIds: ["42"] })))
    .toEqual({ botToken: "t", ownerId: "42", allowGuestDms: false, memberIds: [] });
  await expect(loadDiscordConfig(await write({ botToken: "t", allowedUserIds: ["1", "2"] }))).rejects.toThrow(/needs ownerId/);
  await expect(loadDiscordConfig(await write({ botToken: "t", allowedUserIds: [] }))).rejects.toThrow(/needs ownerId/);
  await expect(loadDiscordConfig(await write({ botToken: "t" }))).rejects.toThrow(/needs ownerId/);
});

test("an explicit ownerId wins over a legacy allow-list", async () => {
  expect((await loadDiscordConfig(await write({ botToken: "t", allowedUserIds: ["1", "2"], ownerId: "2" }))).ownerId).toBe("2");
});
