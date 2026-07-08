import { expect, test } from "vitest";
import { availableModels, pickModel, resolveModelAlias, MODELS } from "../src/models.js";

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

test("pickModel keeps an explicit pick the current CLI supports", () => {
  expect(pickModel(availableModels(["opencode", "claude"]), "opencode", "gpt-5-mini")).toBe("gpt-5-mini");
});

test("pickModel drops a pick unsupported by the current CLI and falls back to a supported one", () => {
  // gpt-5-mini has no claude alias — switching CLI to claude must not launch it silently.
  const picked = pickModel(availableModels(["opencode", "claude"]), "claude", "gpt-5-mini");
  expect(picked).toBe("sonnet-4-5");
  expect(resolveModelAlias(picked!, "claude")).toBeDefined();
});

test("pickModel ignores a last-used model the current CLI can't run", () => {
  expect(pickModel(availableModels(["claude"]), "claude", undefined, "gpt-5-mini")).toBe("sonnet-4-5");
});

test("pickModel prefers a supported last-used model when there's no explicit pick", () => {
  expect(pickModel(availableModels(["opencode", "claude"]), "claude", undefined, "opus-4-5")).toBe("opus-4-5");
});
