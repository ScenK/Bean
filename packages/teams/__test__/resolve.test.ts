import { expect, test } from "vitest";
import { memoryUpdatesFor, resolveCliModel } from "../src/resolve.js";

test("stated cli+model win when the cli is detected", () => {
  const r = resolveCliModel(["claude", "opencode"], { cli: "opencode", model: "gpt-5-5" }, {});
  expect(r).toEqual({ cli: "opencode", model: "gpt-5-5" });
});

test("a stated model unsupported by the resolved cli falls back to a supported model", () => {
  // gpt-5-5 only exists on opencode; cli resolves to claude → pickModel must not keep it
  const r = resolveCliModel(["claude"], { model: "gpt-5-5" }, {});
  expect(r?.cli).toBe("claude");
  expect(r?.model).toBe("sonnet");
});

test("falls back to last-used cli from memory, then to first detected", () => {
  expect(resolveCliModel(["claude", "opencode"], {}, { "teams:cli": "opencode" })?.cli).toBe("opencode");
  expect(resolveCliModel(["claude", "opencode"], {}, {})?.cli).toBe("claude");
});

test("last-used cli no longer detected is ignored", () => {
  expect(resolveCliModel(["claude"], {}, { "teams:cli": "opencode" })?.cli).toBe("claude");
});

test("last-used model per cli is remembered", () => {
  const r = resolveCliModel(["claude"], {}, { "teams:model:claude": "opus" });
  expect(r?.model).toBe("opus");
});

test("returns undefined when no cli is detected", () => {
  expect(resolveCliModel([], { cli: "claude" }, {})).toBeUndefined();
});

test("memoryUpdatesFor emits namespaced keys", () => {
  expect(memoryUpdatesFor({ cli: "claude", model: "opus" })).toEqual({
    "teams:cli": "claude",
    "teams:model:claude": "opus",
  });
  expect(memoryUpdatesFor({ cli: "claude" })).toEqual({ "teams:cli": "claude" });
});
