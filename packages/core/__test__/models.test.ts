import { expect, test } from "vitest";
import { availableModels, pickModel, resolveCliModelSelection } from "../src/models.js";
import type { CliModels } from "../src/cli-models.js";

const CLI_MODELS: CliModels[] = [
  { provider: "claude", models: ["sonnet", "opus", "haiku"] },
  { provider: "opencode", models: ["github-copilot/gpt-5.5", "github-copilot/claude-sonnet-5"] },
];

test("availableModels lists every configured model, marking undetected providers unavailable", () => {
  const result = availableModels(CLI_MODELS, ["claude"]);
  expect(result).toHaveLength(5);
  expect(result.find((m) => m.id === "sonnet")?.availableOn).toEqual(["claude"]);
  expect(result.find((m) => m.id === "github-copilot/gpt-5.5")?.availableOn).toEqual([]);
});

test("availableModels derives the label from the last path segment", () => {
  const result = availableModels(CLI_MODELS, ["claude", "opencode"]);
  expect(result.find((m) => m.id === "github-copilot/gpt-5.5")?.label).toBe("gpt-5.5");
  expect(result.find((m) => m.id === "sonnet")?.label).toBe("sonnet");
});

test("availableModels with no detected CLIs marks every model unavailable", () => {
  expect(availableModels(CLI_MODELS, []).every((m) => m.availableOn.length === 0)).toBe(true);
});

test("a model listed under both providers gets both in availableOn", () => {
  const shared: CliModels[] = [
    { provider: "claude", models: ["sonnet"] },
    { provider: "opencode", models: ["sonnet"] },
  ];
  const result = availableModels(shared, ["claude", "opencode"]);
  expect(result).toHaveLength(1);
  expect(result[0]?.availableOn).toEqual(["claude", "opencode"]);
});

test("pickModel keeps an explicit pick the current CLI supports", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "opencode", "github-copilot/claude-sonnet-5")).toBe("github-copilot/claude-sonnet-5");
});

test("pickModel drops a pick unsupported by the current CLI and falls back to a supported one", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "claude", "github-copilot/claude-sonnet-5")).toBe("sonnet");
});

test("pickModel ignores a last-used model the current CLI can't run", () => {
  const models = availableModels(CLI_MODELS, ["claude"]);
  expect(pickModel(models, "claude", undefined, "github-copilot/claude-sonnet-5")).toBe("sonnet");
});

test("pickModel prefers a supported last-used model when there's no explicit pick", () => {
  const models = availableModels(CLI_MODELS, ["opencode", "claude"]);
  expect(pickModel(models, "opencode", undefined, "github-copilot/claude-sonnet-5")).toBe("github-copilot/claude-sonnet-5");
});

test("pickModel with an empty models list returns undefined", () => {
  expect(pickModel([], "claude")).toBeUndefined();
});

test("pickModel omits --model when the selected CLI has no configured supported model", () => {
  const models = availableModels(CLI_MODELS, ["claude"]);
  expect(pickModel(models, "codex", "sonnet")).toBeUndefined();
});

test("default CLI/model selection skips models whose provider is disabled", () => {
  const models = availableModels(CLI_MODELS, ["opencode"]);
  expect(resolveCliModelSelection(models, ["opencode"])).toEqual({
    cli: "opencode",
    model: "github-copilot/gpt-5.5",
  });
});

test("CLI/model selection returns undefined when every CLI is disabled", () => {
  const models = availableModels(CLI_MODELS, []);
  expect(resolveCliModelSelection(models, [])).toBeUndefined();
});

test("an explicit model selects a compatible enabled CLI instead of an unrelated preferred CLI", () => {
  const models = availableModels(CLI_MODELS, ["claude", "opencode"]);
  expect(resolveCliModelSelection(models, ["claude", "opencode"], {
    cli: "claude",
    model: "github-copilot/gpt-5.5",
  })).toEqual({ cli: "opencode", model: "github-copilot/gpt-5.5" });
});

test("a CLI with no configured models remains selectable without passing another provider's model", () => {
  const models = availableModels(CLI_MODELS, ["codex"]);
  expect(resolveCliModelSelection(models, ["codex"], { cli: "codex" })).toEqual({ cli: "codex" });
});
