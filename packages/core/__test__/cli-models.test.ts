import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadCliModels } from "../src/cli-models.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bean-clis-"));
}

const DEFAULTS = JSON.stringify([
  { provider: "claude", models: ["sonnet", "opus"] },
  { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
]);

test("loads defaults when the user file is missing", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  const result = await loadCliModels(join(d, "default.json"), join(d, "nope.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["sonnet", "opus"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});

test("a user entry replaces that provider's default list entirely", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  await writeFile(join(d, "user.json"), JSON.stringify([{ provider: "claude", models: ["haiku"] }]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["haiku"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});

test("invalid JSON in the user file degrades to defaults", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  await writeFile(join(d, "user.json"), "{not json");
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toHaveLength(2);
});

test("unknown providers are skipped, non-string models filtered", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), JSON.stringify([
    { provider: "unknown", models: ["gpt-5"] },
    { provider: "claude", models: ["sonnet", 42, ""] },
  ]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "nope.json"));
  expect(result).toEqual([{ provider: "claude", models: ["sonnet"] }]);
});

test("codex is a known provider", async () => {
  const d = await dir();
  const defaults = join(d, "default.json");
  await writeFile(defaults, JSON.stringify([{ provider: "codex", models: ["gpt-5.6-sol"] }]));
  const models = await loadCliModels(defaults, "/nonexistent/clis.json");
  expect(models).toEqual([{ provider: "codex", models: ["gpt-5.6-sol"] }]);
});

test("missing default file yields an empty list", async () => {
  const d = await dir();
  expect(await loadCliModels(join(d, "nope.json"), join(d, "also-nope.json"))).toEqual([]);
});

test("a user file can add a provider absent from defaults", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), JSON.stringify([{ provider: "claude", models: ["sonnet"] }]));
  await writeFile(join(d, "user.json"), JSON.stringify([{ provider: "opencode", models: ["github-copilot/gpt-5.5"] }]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["sonnet"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
  ]);
});
