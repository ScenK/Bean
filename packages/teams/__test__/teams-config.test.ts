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
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw", tenantId: "tid" }), "utf8");
  expect(await loadTeamsConfig(file)).toEqual({ botAppId: "id", botAppPassword: "pw", tenantId: "tid", port: 3978, publicBaseUrl: "" });
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

test("publicBaseUrl is kept and trailing slashes stripped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-teams-"));
  const file = join(dir, "teams.json");
  await writeFile(file, JSON.stringify({ botAppId: "id", botAppPassword: "pw", tenantId: "tid", publicBaseUrl: "https://x.example//" }));
  expect((await loadTeamsConfig(file)).publicBaseUrl).toBe("https://x.example");
});
