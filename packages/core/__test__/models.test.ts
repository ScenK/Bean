import { expect, test } from "vitest";
import { availableModels, resolveModelAlias, MODELS } from "../src/models.js";

test("resolveModelAlias returns the CLI-specific flag value", () => {
  expect(resolveModelAlias("sonnet-4-5", "opencode")).toBe("claude-sonnet-4-5");
  expect(resolveModelAlias("sonnet-4-5", "claude")).toBe("sonnet-4-5");
});

test("resolveModelAlias returns undefined for an unknown model or a CLI with no alias", () => {
  expect(resolveModelAlias("does-not-exist", "opencode")).toBeUndefined();
  expect(resolveModelAlias("gpt-5-mini", "claude")).toBeUndefined();
});

test("availableModels annotates each model with which detected CLIs actually support it", () => {
  const result = availableModels(["claude"]);
  expect(result).toHaveLength(MODELS.length);
  const sonnet = result.find((m) => m.id === "sonnet-4-5");
  expect(sonnet?.availableOn).toEqual(["claude"]);
  const gpt = result.find((m) => m.id === "gpt-5-mini");
  expect(gpt?.availableOn).toEqual([]);
});

test("availableModels with no detected CLIs marks every model unavailable", () => {
  expect(availableModels([]).every((m) => m.availableOn.length === 0)).toBe(true);
});
