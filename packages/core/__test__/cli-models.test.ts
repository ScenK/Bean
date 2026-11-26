import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cliOffersEffort, cliOffersModel, loadCliModels, resolveWireModel, watchCliModels } from "../src/cli-models.js";

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

test("a user entry's add/hide adjust the default list instead of replacing it", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  await writeFile(join(d, "user.json"), JSON.stringify([
    { provider: "claude", add: ["haiku", "sonnet"], hide: ["opus"] },
    { provider: "codex", add: ["gpt-6.1-sol"] },
  ]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "user.json"));
  expect(result).toEqual([
    { provider: "claude", models: ["sonnet", "haiku"] },
    { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
    { provider: "codex", models: ["gpt-6.1-sol"] },
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

test("cliOffersModel: only that CLI's listed models, never a dash-led value", () => {
  const cm = [{ provider: "claude" as const, models: ["opus", "-x"] }, { provider: "codex" as const, models: ["gpt-5.5"] }];
  expect(cliOffersModel(cm, "claude", "opus")).toBe(true);
  expect(cliOffersModel(cm, "claude", "gpt-5.5")).toBe(false);
  expect(cliOffersModel(cm, "claude", "-x")).toBe(false);
  expect(cliOffersModel(cm, "opencode", "opus")).toBe(false);
});

test("watchCliModels refills the same array in place when the user file changes", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), DEFAULTS);
  const user = join(d, "user.json");
  const { cliModels, stop } = await watchCliModels(join(d, "default.json"), user, 20);
  try {
    expect(cliModels.find((e) => e.provider === "claude")?.models).toEqual(["sonnet", "opus"]);
    await writeFile(user, JSON.stringify([{ provider: "claude", models: ["haiku"] }]));
    await expect.poll(() => cliModels.find((e) => e.provider === "claude")?.models, { timeout: 3000 }).toEqual(["haiku"]);
  } finally {
    stop();
  }
});

test("structured models parse efforts, defaultEffort, and effortIds while keeping legacy aliases valid", async () => {
  const d = await dir();
  await writeFile(join(d, "default.json"), JSON.stringify([
    {
      provider: "claude",
      models: [
        { id: "haiku", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      ],
    },
    {
      provider: "agy",
      models: [
        {
          id: "gemini-4-neon",
          efforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "high",
          effortIds: { low: "gemini-4-neon-low", medium: "gemini-4-neon-medium", high: "gemini-4-neon-high", xhigh: "gemini-4-neon-xhigh" },
        },
      ],
    },
  ]));
  const result = await loadCliModels(join(d, "default.json"), join(d, "nope.json"));
  expect(cliOffersModel(result, "claude", "haiku")).toBe(true);
  expect(cliOffersEffort(result, "claude", "haiku", "max")).toBe(true);
  expect(cliOffersEffort(result, "claude", "haiku", "bogus")).toBe(false);
  expect(cliOffersModel(result, "agy", "gemini-4-neon")).toBe(true);
  // Legacy suffixed agy id from an existing sprout stays valid.
  expect(cliOffersModel(result, "agy", "gemini-4-neon-high")).toBe(true);
  // Flag-based CLI passes effort only when explicitly provided.
  expect(resolveWireModel(result, "claude", "haiku")).toEqual({ model: "haiku" });
  expect(resolveWireModel(result, "claude", "haiku", "low")).toEqual({ model: "haiku", effort: "low" });
  // effortIds CLI maps base id + effort (or defaultEffort) onto its literal wire model id.
  expect(resolveWireModel(result, "agy", "gemini-4-neon", "xhigh")).toEqual({ model: "gemini-4-neon-xhigh" });
  expect(resolveWireModel(result, "agy", "gemini-4-neon")).toEqual({ model: "gemini-4-neon-high" });
  expect(resolveWireModel(result, "agy", "gemini-4-neon-low")).toEqual({ model: "gemini-4-neon-low" });
});
