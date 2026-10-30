import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDesktopChat, saveDesktopChat, deleteDesktopChat, DESKTOP_CHAT_MAX_BYTES } from "@bean/core";
import { buildChatThreadHandlers, registerIpc, type RegisterDeps } from "../src/ipc.js";
import { IPC } from "../src/channels.js";

const ID = "0b6c4a52-1f5e-4c55-9a3e-2c6f0d9e7a10";
const OTHER = "9f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";

function setup() {
  const dbFile = join(mkdtempSync(join(tmpdir(), "bean-thread-")), "bean.db");
  const handlers = buildChatThreadHandlers({ dbFile, saveDesktopChat, getDesktopChat, deleteDesktopChat });
  return { dbFile, handlers, row: (id = ID) => getDesktopChat(dbFile, id) };
}
const save = (items: unknown[] = [{ kind: "status", id: "item-1", text: "hi", tone: "info" }], id = ID) => ({ id, title: "hi there", items });

describe("buildChatThreadHandlers", () => {
  it("saves and acks with id, title and updatedAt", () => {
    const { handlers, row } = setup();
    const ack = handlers.save(1, { ...save(), noteSlug: "my-note" });
    expect(ack).toMatchObject({ id: ID, title: "hi there" });
    expect(Date.parse(ack!.updatedAt)).not.toBeNaN();
    expect(row()).toMatchObject({ title: "hi there", noteSlug: "my-note" });
    expect(JSON.parse(row()!.itemsJson)).toHaveLength(1);
  });

  it("refuses a bad id, a malformed payload, an oversized payload and a second thread in one window", () => {
    const { handlers, row } = setup();
    expect(() => handlers.save(1, save([], "../etc"))).toThrow(/UUID/);
    expect(() => handlers.save(1, { id: ID, title: 3, items: [] })).toThrow(/malformed/);
    expect(() => handlers.save(1, { ...save(), noteSlug: 5 })).toThrow(/malformed/);
    expect(() => handlers.save(1, save(["x".repeat(DESKTOP_CHAT_MAX_BYTES)]))).toThrow(/too large/);
    expect(row()).toBeUndefined();
    handlers.save(1, save());
    expect(() => handlers.save(1, save([], OTHER))).toThrow(/different/);
    expect(row(OTHER)).toBeUndefined();
  });

  it("incognito latches before deleting: a queued save, a toggle-off and the final close write all lose", () => {
    const { handlers, row } = setup();
    handlers.save(1, save());
    expect(row()).toBeDefined();
    handlers.setIncognito(1, true);
    expect(row()).toBeUndefined();
    expect(handlers.save(1, save())).toBeUndefined(); // the debounce queued before the toggle
    handlers.setIncognito(1, false);
    expect(handlers.save(1, save())).toBeUndefined(); // after toggling back off
    expect(handlers.save(1, save())).toBeUndefined(); // the final close write
    expect(row()).toBeUndefined();
    // Other windows are unaffected.
    expect(handlers.save(2, save([], OTHER))).toBeDefined();
  });

  it("a window that goes incognito before its first save never writes", () => {
    const { handlers, row } = setup();
    handlers.setIncognito(1, true);
    expect(handlers.save(1, save())).toBeUndefined();
    expect(row()).toBeUndefined();
  });

  it("restores the pending thread once and pins it; incognito then deletes the restored row", () => {
    const { dbFile, handlers, row } = setup();
    saveDesktopChat(dbFile, { id: ID, title: "old", itemsJson: JSON.stringify([{ kind: "user", id: "item-1", text: "hey" }]), noteSlug: "n" });
    expect(handlers.pending(1)).toBeUndefined();
    handlers.setPending(ID);
    expect(handlers.pending(1)).toEqual({ id: ID, title: "old", items: [{ kind: "user", id: "item-1", text: "hey" }], noteSlug: "n" });
    expect(handlers.pending(1)).toBeUndefined(); // pulled once
    expect(() => handlers.save(1, save([], OTHER))).toThrow(/different/);
    handlers.setIncognito(1, true);
    expect(row()).toBeUndefined();
  });

  it("a deleted or pruned pending thread restores as missing", () => {
    const { handlers } = setup();
    handlers.setPending(OTHER);
    expect(handlers.pending(1)).toEqual({ missing: true });
  });
});

describe("chat thread IPC", () => {
  it("refuses a sender that isn't the chat window", async () => {
    const handles = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
    const ons = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handles.set(ch, fn); },
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { ons.set(ch, fn); },
    };
    const { handlers, row } = setup();
    const chat = { id: 1 }, other = { id: 2 };
    const given: Partial<RegisterDeps> = { isChatSender: (s) => s === (chat as never), chatThreadHandlers: handlers };
    // Every other dep is a no-op: registration only stores handlers.
    const deps = new Proxy(given, { get: (t, k) => (k in t ? t[k as keyof typeof t] : vi.fn()) }) as RegisterDeps;
    registerIpc(ipcMain as never, deps);
    const saveCh = handles.get(IPC.chatThreadSave)!;
    expect(() => saveCh({ sender: other }, save())).toThrow(/chat window/);
    expect(() => handles.get(IPC.getPendingChatThread)!({ sender: other })).toThrow(/chat window/);
    expect(row()).toBeUndefined();
    expect(saveCh({ sender: chat }, save())).toMatchObject({ id: ID });
    // Another window's 🕶 never latches or deletes the chat's thread.
    ons.get(IPC.chatIncognito)!({ sender: other }, true);
    expect(row()).toBeDefined();
    ons.get(IPC.chatIncognito)!({ sender: chat }, true);
    expect(row()).toBeUndefined();
    expect(saveCh({ sender: chat }, save())).toBeUndefined();
  });
});
