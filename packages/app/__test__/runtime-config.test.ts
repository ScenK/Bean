import { expect, test } from "vitest";
import { createRuntimeConfig } from "../src/runtime-config.js";

test("apply saves config and rebuilds clients with the new key", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string }[] = [];
  const madeChat: string[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: (k) => { madeChat.push(k); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getModel()).toBe("gpt-4o-mini");
  expect(rt.getApiKey()).toBe("sk-old");
  expect(madeChat).toEqual(["sk-old"]);

  await rt.apply({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "" });

  expect(saved).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "" }]);
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getApiKey()).toBe("sk-new");
  expect(madeChat).toEqual(["sk-old", "sk-new"]);
});

test("the stable chat wrapper delegates to the current client after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "a", model: "m", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: (k) => (async () => "R:" + k) as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );
  const wrapper = rt.chat;
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:a");
  await rt.apply({ openaiApiKey: "b", model: "m", terminalApp: "", editorApp: "", delegateCli: "" });
  // same wrapper reference, new underlying client
  expect(rt.chat).toBe(wrapper);
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:b");
});

test("apply builds clients before persisting: a failing makeChat leaves disk and state untouched", async () => {
  let saved = 0;
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: (k) => { if (k === "bad") throw new Error("bad key"); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => { saved++; },
    },
  );
  await expect(rt.apply({ openaiApiKey: "bad", model: "gpt-5", terminalApp: "", editorApp: "", delegateCli: "" })).rejects.toThrow("bad key");
  expect(saved).toBe(0);          // never persisted
  expect(rt.getApiKey()).toBe("sk-old");  // state unchanged
  expect(rt.getModel()).toBe("gpt-4o-mini");
});

test("getTerminalApp reflects the initial value and updates after apply", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string }[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getTerminalApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app", editorApp: "", delegateCli: "" });

  expect(rt.getTerminalApp()).toBe("/Applications/iTerm.app");
  expect(saved).toEqual([{ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app", editorApp: "", delegateCli: "" }]);
});

test("getEditorApp reflects the initial value and updates after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );

  expect(rt.getEditorApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "/Applications/Zed.app", delegateCli: "" });

  expect(rt.getEditorApp()).toBe("/Applications/Zed.app");
});

test("getDelegateCli reflects the initial value and updates after apply", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string; editorApp: string; delegateCli: string }[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getDelegateCli()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "claude" });

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
      makeChat: () => (async () => "") as never,
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
  });
  expect(runtime.getDisabledClis()).toEqual([]);
  expect(saved[0]).toMatchObject({ disabledClis: [] });
});
