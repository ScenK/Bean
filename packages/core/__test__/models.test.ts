import { expect, test } from "vitest";
import { availableModels, pickModel, resolveModelAlias, MODELS } from "../src/models.js";

test("resolveModelAlias returns the CLI-specific flag value", () => {
  expect(resolveModelAlias("sonnet", "claude")).toBe("sonnet");
  expect(resolveModelAlias("claude-sonnet-5", "opencode")).toBe("github-copilot/claude-sonnet-5");
});

test("resolveModelAlias returns undefined for an unknown model or a CLI with no alias", () => {
  expect(resolveModelAlias("does-not-exist", "opencode")).toBeUndefined();
  // sonnet is a claude-only model — no opencode alias, since the two CLIs' catalogs don't overlap.
  expect(resolveModelAlias("sonnet", "opencode")).toBeUndefined();
});

test("availableModels annotates each model with which detected CLIs actually support it", () => {
  const result = availableModels(["claude"]);
  expect(result).toHaveLength(MODELS.length);
  const sonnet = result.find((m) => m.id === "sonnet");
  expect(sonnet?.availableOn).toEqual(["claude"]);
  const gpt = result.find((m) => m.id === "gpt-5-5");
  expect(gpt?.availableOn).toEqual([]);
});

test("availableModels with no detected CLIs marks every model unavailable", () => {
  expect(availableModels([]).every((m) => m.availableOn.length === 0)).toBe(true);
});

test("pickModel keeps an explicit pick the current CLI supports", () => {
  expect(pickModel(availableModels(["opencode", "claude"]), "opencode", "claude-sonnet-5")).toBe("claude-sonnet-5");
});

test("pickModel drops a pick unsupported by the current CLI and falls back to a supported one", () => {
  // claude-sonnet-5 is opencode-only — switching CLI to claude must not launch it silently.
  const picked = pickModel(availableModels(["opencode", "claude"]), "claude", "claude-sonnet-5");
  expect(picked).toBe("sonnet");
  expect(resolveModelAlias(picked!, "claude")).toBeDefined();
});

test("pickModel ignores a last-used model the current CLI can't run", () => {
  expect(pickModel(availableModels(["claude"]), "claude", undefined, "claude-sonnet-5")).toBe("sonnet");
});

test("pickModel prefers a supported last-used model when there's no explicit pick", () => {
  expect(pickModel(availableModels(["opencode", "claude"]), "opencode", undefined, "claude-sonnet-5")).toBe("claude-sonnet-5");
});
