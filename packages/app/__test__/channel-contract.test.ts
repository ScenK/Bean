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

  it("gates a host-bound channel on the host's capability", () => {
    expect(contractRefusal(IPC.revealInFinder, ["/tmp"], ["pty"])).toMatch(/needs the host's pathOpen capability/);
    expect(contractRefusal(IPC.revealInFinder, ["/tmp"], ["pathOpen"])).toBeUndefined();
    expect(contractRefusal(IPC.terminalStop, ["m"], ["pty"])).toBeUndefined(); // optional trailing tab
    expect(contractRefusal(IPC.chatopsStart, ["slack"], [])).toMatch(/malformed/);
  });
});
