import { describe, expect, it, vi } from "vitest";
import { REMOTE_OPS } from "@bean/host";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC, NO_CORE, isNoCore } from "../src/channels.js";
import { CHANNEL_CONTRACT, contractRefusal, guardIpc, registerNoCore } from "../src/channel-contract.js";
import { registerShellIpc, type ShellIpcDeps } from "../src/ipc.js";
import { PUSH_ROUTES } from "../src/push.js";

describe("service contract (#807)", () => {
  it("classifies every channel — a new one without an entry fails here", () => {
    expect(Object.keys(CHANNEL_CONTRACT).sort()).toEqual(Object.keys(IPC).sort());
    expect(contractRefusal("bean:not-a-channel", [], [])).toMatch(/not in the contract/);
  });

  it("a remote attach (#809) only reaches core channels, with the contract's arity", () => {
    for (const [name, op] of Object.entries(REMOTE_OPS)) {
      const c = (CHANNEL_CONTRACT as Record<string, (typeof CHANNEL_CONTRACT)[keyof typeof CHANNEL_CONTRACT]>)[name];
      expect(c?.owner, name).toBe("core");
      expect(c?.owner === "core" ? c.args.length : -1, name).toBe(op.args.length);
    }
    for (const denied of ["getConfig", "saveConfig", "launch", "terminalStart", "chatOpenPath"]) expect(Object.hasOwn(REMOTE_OPS, denied)).toBe(false);
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

describe("no core attached (#810)", () => {
  const ownerOf = (channel: string) => {
    const key = (Object.keys(IPC) as (keyof typeof IPC)[]).find((k) => IPC[k] === channel)!;
    return CHANNEL_CONTRACT[key].owner;
  };

  it("every core and host-bound invoke rejects with the one NO_CORE error; no shell channel is taken", () => {
    const handles = new Map<string, () => unknown>();
    registerNoCore({ handle: (c, f) => { handles.set(c, f as never); } });
    for (const [key, c] of Object.entries(CHANNEL_CONTRACT)) {
      const channel = IPC[key as keyof typeof IPC];
      expect(handles.has(channel), key).toBe(c.owner !== "shell");
    }
    let err: unknown;
    try { handles.get(IPC.listNotes)!(); } catch (e) { err = e; }
    expect(isNoCore(err)).toBe(true);
    // What a renderer sees: Electron wraps the main-side error.
    expect(isNoCore(new Error(`Error invoking remote method 'bean:list-notes': Error: ${NO_CORE}`))).toBe(true);
    expect(isNoCore(new Error("boom"))).toBe(false);
  });

  it("the shell half registers only shell channels, so it boots with or without a core", () => {
    const channels: string[] = [];
    const fake = { handle: (c: string) => { channels.push(c); }, on: (c: string) => { channels.push(c); } };
    registerShellIpc(fake, {} as ShellIpcDeps);
    expect(channels.length).toBeGreaterThan(0);
    for (const c of channels) expect(ownerOf(c), c).toBe("shell");
  });
});
