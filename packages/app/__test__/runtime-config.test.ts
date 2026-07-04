import { expect, test } from "vitest";
import { createRuntimeConfig } from "../src/runtime-config.js";

test("apply saves config and rebuilds clients with the new key", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string }[] = [];
  const madeChat: string[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: (k) => { madeChat.push(k); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getModel()).toBe("gpt-4o-mini");
  expect(rt.getApiKey()).toBe("sk-old");
  expect(madeChat).toEqual(["sk-old"]);

  await rt.apply({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "" });

  expect(saved).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "" }]);
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getApiKey()).toBe("sk-new");
  expect(madeChat).toEqual(["sk-old", "sk-new"]);
});

test("the stable chat wrapper delegates to the current client after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "a", model: "m", terminalApp: "" },
    {
      makeChat: (k) => (async () => "R:" + k) as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );
  const wrapper = rt.chat;
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:a");
  await rt.apply({ openaiApiKey: "b", model: "m", terminalApp: "" });
  // same wrapper reference, new underlying client
  expect(rt.chat).toBe(wrapper);
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:b");
});

test("apply builds clients before persisting: a failing makeChat leaves disk and state untouched", async () => {
  let saved = 0;
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: (k) => { if (k === "bad") throw new Error("bad key"); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => { saved++; },
    },
  );
  await expect(rt.apply({ openaiApiKey: "bad", model: "gpt-5", terminalApp: "" })).rejects.toThrow("bad key");
  expect(saved).toBe(0);          // never persisted
  expect(rt.getApiKey()).toBe("sk-old");  // state unchanged
  expect(rt.getModel()).toBe("gpt-4o-mini");
});

test("getTerminalApp reflects the initial value and updates after apply", async () => {
  const saved: { openaiApiKey: string; model: string; terminalApp: string }[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getTerminalApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app" });

  expect(rt.getTerminalApp()).toBe("/Applications/iTerm.app");
  expect(saved).toEqual([{ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "/Applications/iTerm.app" }]);
});

test("getEditorApp reflects the initial value and updates after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "" },
    {
      makeChat: () => (async () => "") as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );

  expect(rt.getEditorApp()).toBe("");

  await rt.apply({ openaiApiKey: "sk-old", model: "gpt-4o-mini", terminalApp: "", editorApp: "/Applications/Zed.app" });

  expect(rt.getEditorApp()).toBe("/Applications/Zed.app");
});
