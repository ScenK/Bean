import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../src/channels.js";
import { CHANNEL_CONTRACT, contractRefusal, guardIpc } from "../src/channel-contract.js";
import { PUSH_ROUTES } from "../src/push.js";

describe("service contract (#807)", () => {
  it("classifies every channel — a new one without an entry fails here", () => {
    expect(Object.keys(CHANNEL_CONTRACT).sort()).toEqual(Object.keys(IPC).sort());
    expect(contractRefusal("bean:not-a-channel", [], [])).toMatch(/not in the contract/);
  });

  it("every channel main registers or the preload calls is in IPC (no string-literal side doors)", () => {
    const src = ["ipc.ts", "main.ts", "avatar-window.ts", "preload.ts"].map((f) => readFileSync(join(__dirname, "../src", f), "utf8")).join("\n");
    expect(src).not.toMatch(/ipc(Main|Renderer)\.(on|handle|send|invoke)\(\s*["'`]/);
  });

  it("pushes the shell's own windows get stay shell; mount and broadcast pushes are core or host-bound", () => {
    for (const [channel, route] of Object.entries(PUSH_ROUTES)) {
      const key = (Object.keys(IPC) as (keyof typeof IPC)[]).find((k) => IPC[k] === channel)!;
      if (route === "window") expect(CHANNEL_CONTRACT[key].owner).toBe("shell");
    }
  });

  it("rejects a malformed call before its handler runs: invokes throw, sends drop", () => {
    const handles = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ons = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipc = guardIpc({ handle: (c, f) => { handles.set(c, f as never); }, on: (c, f) => { ons.set(c, f as never); } }, []);
    const fn = vi.fn(() => "ok");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.handle(IPC.updateMemory, fn);
    ipc.on(IPC.chatStop, fn);
    ipc.handle(IPC.getTheme, fn);
    const e = { sender: { id: 1 } };
    expect(() => handles.get(IPC.updateMemory)!(e, "id", 42)).toThrow(/malformed payload on bean:update-memory/);
    expect(() => handles.get(IPC.updateMemory)!(e, "id", "text", "extra")).toThrow(/malformed/);
    ons.get(IPC.chatStop)!(e, { mountId: "x" }, "t");
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped — malformed payload on bean:chat-stop/));
    expect(handles.get(IPC.updateMemory)!(e, "id", "text")).toBe("ok");
    expect(handles.get(IPC.getTheme)!(e, "anything")).toBe("ok"); // shell: not the host's to check
    warn.mockRestore();
  });

  it("checks an object payload's required fields, not just that it's an object", () => {
    const fn = vi.fn();
    const handles = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipc = guardIpc({ handle: (c, f) => { handles.set(c, f as never); }, on: () => {} }, []);
    for (const ch of [IPC.saveConfig, IPC.saveProjects, IPC.chat]) ipc.handle(ch, fn);
    const call = (ch: string, ...a: unknown[]) => () => handles.get(ch)!({ sender: { id: 1 } }, ...a);
    expect(call(IPC.saveConfig, {})).toThrow(/malformed/); // would have blanked the API key
    expect(call(IPC.saveProjects, [{ name: 42, path: false }])).toThrow(/malformed/);
    expect(call(IPC.chat, {}, "m")).toThrow(/malformed/);
    expect(call(IPC.chat, { history: [{ role: "user", content: 1 }], message: "hi" }, "m")).toThrow(/malformed/);
    expect(fn).not.toHaveBeenCalled();
    const config = {
      openaiApiKey: "k", model: "m", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false,
      reasoningEffort: "", routineDigestContext: false, disabledClis: [], webSearch: false, autoMemory: true,
    };
    call(IPC.saveConfig, config)();
    call(IPC.saveProjects, [{ name: "bean", path: "/p", skills: ["a"] }])();
    call(IPC.chat, { history: [{ role: "user", content: "x" }], message: "hi" }, "m")();
    expect(fn).toHaveBeenCalledTimes(3);
    // Events too.
    const all = ["systemControls", "terminalHandoff", "pty", "pathOpen"] as const;
    expect(contractRefusal(IPC.memoryUpdated, [{ saved: 42, mountId: "m" }], all)).toMatch(/malformed/);
    expect(contractRefusal(IPC.memoryUpdated, [{ saved: [{ id: "1", text: "t" }], mountId: "m" }], all)).toBeUndefined();
    expect(contractRefusal(IPC.routinesPreviewWatch, [{ kind: "feed", command: "ls" }], all)).toMatch(/malformed/);
    expect(contractRefusal(IPC.routinesPreviewWatch, [{ kind: "command", command: "ls" }], all)).toBeUndefined();
  });

  it("gates a host-bound channel on the host's capability", () => {
    expect(contractRefusal(IPC.revealInFinder, ["/tmp"], ["pty"])).toMatch(/needs the host's pathOpen capability/);
    expect(contractRefusal(IPC.revealInFinder, ["/tmp"], ["pathOpen"])).toBeUndefined();
    expect(contractRefusal(IPC.terminalStop, ["m"], ["pty"])).toBeUndefined(); // optional trailing tab
    expect(contractRefusal(IPC.chatopsStart, ["slack"], [])).toMatch(/malformed/);
  });
});
