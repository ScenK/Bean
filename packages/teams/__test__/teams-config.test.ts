import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadTeamsConfig, teamsConfigFile } from "../src/teams-config.js";

test("teamsConfigFile joins dir with teams.json", () => {
  expect(teamsConfigFile("/home/x/.bean")).toBe(join("/home/x/.bean", "teams.json"));
});

test("loads a valid config and defaults port to 3978", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw" }), "utf8");
  expect(await loadTeamsConfig(file)).toEqual({ botAppId: "id", botAppPassword: "pw", port: 3978 });
});

test("missing file throws with a setup hint", async () => {
  await expect(loadTeamsConfig("/nope/teams.json")).rejects.toThrow(/Teams config missing/);
});

test("incomplete config throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id" }), "utf8");
  await expect(loadTeamsConfig(file)).rejects.toThrow(/needs botAppId and botAppPassword/);
});
