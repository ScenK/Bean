import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sharedBotDeps } from "../src/chatops/bot-deps.js";
import { BEAN_GIT_IDENTITY } from "../src/agent-rules.js";
import { configFile, loadConfig, outboxDir } from "../src/config.js";

test("discord and teams get the same keys; only the surface tag differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-bot-deps-"));
  writeFileSync(configFile(dir), JSON.stringify({ openaiApiKey: "sk-test", model: "m" }));
  const config = await loadConfig(configFile(dir), dir);
  const discord = sharedBotDeps({ dir, builtinDir: dir, surface: "discord", config });
  const teams = sharedBotDeps({ dir, builtinDir: dir, surface: "teams", config });

  expect(Object.keys(teams).sort()).toEqual(Object.keys(discord).sort());
  expect(Object.keys(teams.routines).sort()).toEqual(Object.keys(discord.routines).sort());
  for (const [deps, surface] of [[discord, "discord"], [teams, "teams"]] as const) {
    expect(deps.reminders?.transport).toBe(surface);
    expect(deps.send?.transport).toBe(surface);
    expect(deps.routines.transport).toBe(surface);
    expect(deps.catalog?.surface).toBe(surface);
    // Per-surface decisions never come from the shared slice.
    for (const key of ["roles", "cards", "recordDelegateRun", "findDelegateRun"]) expect(deps).not.toHaveProperty(key);
    for (const key of ["recipients", "sprouts"]) expect(deps.routines).not.toHaveProperty(key);
  }

  await teams.routines.notifyOwner("hi");
  const [file] = readdirSync(outboxDir(dir)).filter((f) => f.endsWith(".json"));
  expect(JSON.parse(readFileSync(join(outboxDir(dir), file!), "utf8"))).toMatchObject({ transport: "teams", body: "hi" });
});

test("a bot process commits as the configured identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-bot-deps-git-"));
  writeFileSync(configFile(dir), JSON.stringify({ openaiApiKey: "sk-test", gitName: "Sprout", gitEmail: "s@x" }));
  const saved = { ...BEAN_GIT_IDENTITY };
  try {
    sharedBotDeps({ dir, builtinDir: dir, surface: "discord", config: await loadConfig(configFile(dir), dir) });
    expect(BEAN_GIT_IDENTITY).toMatchObject({ GIT_AUTHOR_NAME: "Sprout", GIT_COMMITTER_EMAIL: "s@x" });
  } finally {
    Object.assign(BEAN_GIT_IDENTITY, saved);
  }
});
