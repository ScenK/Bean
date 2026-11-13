import { expect, test } from "vitest";
import { createRuntimeConfig } from "../src/runtime-config.js";
import type { RuntimeConfig } from "../src/runtime-config.js";

type RuntimeUpdate = Parameters<RuntimeConfig["apply"]>[0];

test("apply saves config and rebuilds clients with the new key", async () => {
  const saved: RuntimeUpdate[] = [];
  const madeConverse: string[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: (k) => { madeConverse.push(k); return (async () => ({ content: "", toolCalls: [] })) as never; },
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getModel()).toBe("gpt-4o-mini");
  expect(rt.getApiKey()).toBe("sk-old");
  expect(madeConverse).toEqual(["sk-old"]);

  await rt.apply({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] });

  expect(saved).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] }]);
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getApiKey()).toBe("sk-new");
  expect(madeConverse).toEqual(["sk-old", "sk-new"]);
});

test("apply is a patch (#812): an omitted key — or any omitted field — keeps its value", async () => {
  const saved: RuntimeUpdate[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-keep", model: "gpt-4o-mini", terminalApp: "/T.app", editorApp: "", delegateCli: "", systemControls: true, reasoningEffort: "", routineDigestContext: false, disabledClis: [], webSearch: false, autoMemory: true },
    { makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never, saveConfigFile: async (u) => { saved.push(u); } },
  );
  await rt.apply({ model: "gpt-5" });
  await rt.apply({});
  expect(rt.getApiKey()).toBe("sk-keep");
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getSystemControls()).toBe(true);
  expect(saved[0]).toMatchObject({ openaiApiKey: "sk-keep", model: "gpt-5", terminalApp: "/T.app", systemControls: true });
  expect(saved[1]).toEqual(saved[0]);
  await rt.apply(JSON.parse('{"__proto__": {"polluted": true}, "webSearch": true}'));
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(rt.getWebSearch()).toBe(true);
});

test("overlapping patches apply in order, each onto the one before (#812)", async () => {
  let release: () => void = () => {};
  const saved: RuntimeUpdate[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, reasoningEffort: "", routineDigestContext: false, disabledClis: [], webSearch: false, autoMemory: true },
    {
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); if (saved.length === 1) await new Promise<void>((r) => { release = r; }); },
    },
  );
  const first = rt.apply({ openaiApiKey: "sk-new" });
  const second = rt.apply({ webSearch: true });
  await new Promise((r) => setTimeout(r, 0));
  release();
  await Promise.all([first, second]);
  expect(saved[1]).toMatchObject({ openaiApiKey: "sk-new", webSearch: true });
  expect(rt.getApiKey()).toBe("sk-new");
  expect(rt.getWebSearch()).toBe(true);
});

test("the stable converse wrapper delegates to the current client after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "a", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: (k) => (async () => "R:" + k) as never,
      saveConfigFile: async () => {},
    },
  );
  const wrapper = rt.converse;
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:a");
  await rt.apply({ openaiApiKey: "b", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] });
  // same wrapper reference, new underlying client
  expect(rt.converse).toBe(wrapper);
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:b");
});

test("apply builds clients before persisting: a failing makeConverse leaves disk and state untouched", async () => {
  let saved = 0;
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: (k) => { if (k === "bad") throw new Error("bad key"); return (async () => ({ content: "", toolCalls: [] })) as never; },
      saveConfigFile: async () => { saved++; },
    },
  );
  await expect(rt.apply({ openaiApiKey: "bad", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] })).rejects.toThrow("bad key");
  expect(saved).toBe(0);          // never persisted
  expect(rt.getApiKey()).toBe("sk-old");  // state unchanged
  expect(rt.getModel()).toBe("gpt-4o-mini");
});

test("getTerminalApp reflects the initial value and updates after apply", async () => {
  const saved: RuntimeUpdate[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getTerminalApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] });

  expect(rt.getTerminalApp()).toBe("/Applications/iTerm.app");
  expect(saved).toEqual([{ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] }]);
});

test("getEditorApp reflects the initial value and updates after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );

  expect(rt.getEditorApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "/Applications/Zed.app", delegateCli: "", systemControls: false, disabledClis: [] });

  expect(rt.getEditorApp()).toBe("/Applications/Zed.app");
});

test("getDelegateCli reflects the initial value and updates after apply", async () => {
  const saved: RuntimeUpdate[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [] },
    {
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getDelegateCli()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "claude", systemControls: false, disabledClis: [] });

  expect(rt.getDelegateCli()).toBe("claude");
  expect(saved[0]).toMatchObject({ delegateCli: "claude" });
});

test("disabledClis is exposed and updated by apply", async () => {
  const saved: unknown[] = [];
  const runtime = createRuntimeConfig(
    {
      openaiApiKey: "",
      model: "m",
      terminalApp: "",
      editorApp: "",
      delegateCli: "",
      systemControls: false,
      disabledClis: ["codex"],
    },
    {
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (update) => { saved.push(update); },
    },
  );

  expect(runtime.getDisabledClis()).toEqual(["codex"]);
  await runtime.apply({
    openaiApiKey: "",
    model: "m",
    terminalApp: "",
    editorApp: "",
    delegateCli: "",
    systemControls: false,
    disabledClis: [],
    webSearch: false,
  });
  expect(runtime.getDisabledClis()).toEqual([]);
  expect(saved[0]).toMatchObject({ disabledClis: [] });
});

test("reasoning effort reaches the converse client and is rebuilt on save", async () => {
  const madeConverse: string[] = [];
  const saved: RuntimeUpdate[] = [];
  const rt = createRuntimeConfig(
    {
      openaiApiKey: "sk-x",
      model: "gpt-5.6-luna",
      terminalApp: "",
      editorApp: "",
      delegateCli: "",
      systemControls: false,
      reasoningEffort: "low",
      routineDigestContext: false,
      disabledClis: [],
      webSearch: false,
    },
    {
      makeConverse: (_k, effort) => { madeConverse.push(effort); return (async () => ({ content: "", toolCalls: [] })) as never; },
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getReasoningEffort()).toBe("low");
  expect(madeConverse).toEqual(["low"]);

  await rt.apply({
    openaiApiKey: "sk-x",
    model: "gpt-5.6-luna",
    terminalApp: "",
    editorApp: "",
    delegateCli: "",
    systemControls: false,
    reasoningEffort: "high",
    routineDigestContext: false,
    disabledClis: [],
    webSearch: false,
  });

  // Rebuilt, not just stored — the effort is baked into the client at construction.
  expect(madeConverse).toEqual(["low", "high"]);
  expect(rt.getReasoningEffort()).toBe("high");
  expect(saved[0]).toMatchObject({ reasoningEffort: "high" });
});
