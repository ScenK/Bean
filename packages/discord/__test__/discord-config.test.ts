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
  const file = await write({ botToken: "t", allowedUserIds: ["123"] });
  expect(await loadDiscordConfig(file)).toEqual({ botToken: "t", allowedUserIds: ["123"] });
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

test("empty botToken or empty allowlist throws (would ignore everyone)", async () => {
  await expect(loadDiscordConfig(await write({ botToken: "", allowedUserIds: ["1"] })))
    .rejects.toThrow(/needs botToken and a non-empty allowedUserIds/);
  await expect(loadDiscordConfig(await write({ botToken: "t", allowedUserIds: [] })))
    .rejects.toThrow(/needs botToken and a non-empty allowedUserIds/);
});
