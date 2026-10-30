import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDesktopChat, saveDesktopChat, deleteDesktopChat, listDesktopChats, DESKTOP_CHAT_MAX_BYTES } from "@bean/core";
import { buildChatThreadHandlers, registerIpc, type RegisterDeps } from "../src/ipc.js";
import { IPC } from "../src/channels.js";
import type { Memory } from "@bean/core";

const ID = "0b6c4a52-1f5e-4c55-9a3e-2c6f0d9e7a10";
const OTHER = "9f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";

function setup() {
  const dbFile = join(mkdtempSync(join(tmpdir(), "bean-thread-")), "bean.db");
  const handlers = buildChatThreadHandlers({ dbFile, saveDesktopChat, getDesktopChat, deleteDesktopChat, listDesktopChats });
  return { dbFile, handlers, row: (id = ID) => getDesktopChat(dbFile, id) };
}
const save = (items: unknown[] = [{ kind: "status", id: "item-1", text: "hi", tone: "info" }], id = ID) => ({ id, title: "hi there", items });

describe("buildChatThreadHandlers", () => {
  it("saves and acks with id, title and updatedAt", () => {
    const { handlers, row } = setup();
    const ack = handlers.save("a", { ...save(), noteSlug: "my-note" });
    expect(ack).toMatchObject({ id: ID, title: "hi there" });
    expect(Date.parse(ack!.updatedAt)).not.toBeNaN();
    expect(row()).toMatchObject({ title: "hi there", noteSlug: "my-note" });
    expect(JSON.parse(row()!.itemsJson)).toHaveLength(1);
  });

  it("refuses a bad id, a malformed payload, an oversized payload and a second thread in one chat", () => {
    const { handlers, row } = setup();
    expect(() => handlers.save("a", save([], "../etc"))).toThrow(/UUID/);
    expect(() => handlers.save("a", { id: ID, title: 3, items: [] })).toThrow(/malformed/);
    expect(() => handlers.save("a", { ...save(), noteSlug: 5 })).toThrow(/malformed/);
    expect(() => handlers.save("a", save(["x".repeat(DESKTOP_CHAT_MAX_BYTES)]))).toThrow(/too large/);
    expect(row()).toBeUndefined();
    handlers.save("a", save());
    expect(() => handlers.save("a", save([], OTHER))).toThrow(/different/);
    expect(row(OTHER)).toBeUndefined();
  });

  it("incognito latches before deleting: a queued save, a toggle-off and the final close write all lose", () => {
    const { handlers, row } = setup();
    handlers.save("a", save());
    expect(row()).toBeDefined();
    handlers.setIncognito("a", true);
    expect(row()).toBeUndefined();
    expect(handlers.save("a", save())).toBeUndefined(); // the debounce queued before the toggle
    handlers.setIncognito("a", false);
    expect(handlers.save("a", save())).toBeUndefined(); // after toggling back off
    expect(handlers.save("a", save())).toBeUndefined(); // the final close write
    expect(row()).toBeUndefined();
    // Other chats (same window or not) are unaffected.
    expect(handlers.save("b", save([], OTHER))).toBeDefined();
  });

  it("a chat that goes incognito before its first save never writes", () => {
    const { handlers, row } = setup();
    handlers.setIncognito("a", true);
    expect(handlers.save("a", save())).toBeUndefined();
    expect(row()).toBeUndefined();
  });

  it("restores a thread and pins it; incognito then deletes the restored row", () => {
    const { dbFile, handlers, row } = setup();
    saveDesktopChat(dbFile, { id: ID, title: "old", itemsJson: JSON.stringify([{ kind: "user", id: "item-1", text: "hey" }]), noteSlug: "n" });
    expect(handlers.get("a", ID)).toEqual({ id: ID, title: "old", items: [{ kind: "user", id: "item-1", text: "hey" }], noteSlug: "n" });
    expect(() => handlers.save("a", save([], OTHER))).toThrow(/different/);
    handlers.setIncognito("a", true);
    expect(row()).toBeUndefined();
  });

  it("lists threads and deletes any no open chat holds", () => {
    const { dbFile, handlers, row } = setup();
    handlers.save("a", save());
    saveDesktopChat(dbFile, { id: OTHER, title: "other", itemsJson: "[]" });
    expect(handlers.list().map((t) => t.id).sort()).toEqual([ID, OTHER].sort());
    expect(() => handlers.delete(ID)).toThrow(/open chat/);
    expect(() => handlers.delete("../x")).toThrow(/UUID/);
    expect(row()).toBeDefined();
    handlers.delete(OTHER);
    expect(row(OTHER)).toBeUndefined();
    handlers.release("a"); // the chat is gone: its thread is free to delete
    handlers.delete(ID);
    expect(row()).toBeUndefined();
  });

  it("two chats save two threads; neither may save, restore or delete the other's", () => {
    const { dbFile, handlers, row } = setup();
    handlers.save("a", save());
    handlers.save("b", save([], OTHER));
    expect(row()).toBeDefined();
    expect(row(OTHER)).toBeDefined();
    expect(() => handlers.save("c", save())).toThrow(/another open chat/);
    expect(() => handlers.get("c", OTHER)).toThrow(/already open/);
    expect(() => handlers.delete(OTHER)).toThrow(/open chat/);
    // get pins: the restored chat saves only that thread, and it can't be opened twice.
    const third = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    saveDesktopChat(dbFile, { id: third, title: "t", itemsJson: "[1]" });
    expect(handlers.get("c", third)).toMatchObject({ id: third, items: [1] });
    expect(() => handlers.save("c", save())).toThrow(/different/);
    expect(() => handlers.get("d", third)).toThrow(/already open/);
    expect(() => handlers.get("c", "../x")).toThrow(/UUID/);
    // Released, B's thread is free for a new mount.
    handlers.release("b");
    expect(handlers.get("d", OTHER)).toMatchObject({ id: OTHER });
  });

  it("a deleted or pruned thread restores as missing", () => {
    const { handlers } = setup();
    expect(handlers.get("a", OTHER)).toEqual({ missing: true });
  });
});

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";

function ipcHarness(given: Partial<RegisterDeps> = {}) {
  const handles = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  const ons = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handles.set(ch, fn); },
    on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { ons.set(ch, fn); },
  };
  const { handlers, row } = setup();
  const chat = { id: 1, isDestroyed: () => false, send: vi.fn() }, other = { id: 2, isDestroyed: () => false, send: vi.fn() };
  const delegateTasks = { start: vi.fn(async () => "t1"), cancel: vi.fn(), cancelMount: vi.fn() };
  const all: Partial<RegisterDeps> = { isChatSender: (s) => s === (chat as never), chatThreadHandlers: handlers, delegateTasks, ...given };
  // Every other dep is a no-op: registration only stores handlers.
  const deps = new Proxy(all, { get: (t, k) => (k in t ? t[k as keyof typeof t] : vi.fn()) }) as RegisterDeps;
  const { releaseChatSender } = registerIpc(ipcMain as never, deps);
  const invoke = (ch: string, sender: unknown, ...args: unknown[]): unknown => handles.get(ch)!({ sender }, ...args);
  const emit = (ch: string, sender: unknown, ...args: unknown[]): unknown => ons.get(ch)!({ sender }, ...args);
  return { handlers, row, chat, other, delegateTasks, releaseChatSender, invoke, emit };
}

describe("chat thread IPC", () => {
  it("per-chat requests need the chat window and a mount attached to it", async () => {
    const { row, chat, other, invoke, emit, delegateTasks } = ipcHarness();
    emit(IPC.chatAttach, chat, A);
    emit(IPC.chatAttach, other, B); // non-chat senders can't attach
    emit(IPC.chatAttach, chat, "not-a-uuid");
    expect(() => invoke(IPC.chatThreadSave, other, save(), A)).toThrow(/chat window/);
    expect(() => invoke(IPC.chatThreadSave, chat, save(), B)).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.chatThreadSave, chat, save(), "not-a-uuid")).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.chatThreadSave, chat, save())).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.chatThreadGet, other, ID, A)).toThrow(/chat window/);
    expect(() => invoke(IPC.chatThreadGet, chat, ID, B)).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.delegateStart, chat, { projectPath: "", prompt: "p", instruction: "i" }, B)).toThrow(/unknown chat session/);
    await expect(invoke(IPC.chat, chat, { history: [], message: "hi" }, B)).rejects.toThrow(/unknown chat session/);
    expect(delegateTasks.start).not.toHaveBeenCalled();
    expect(row()).toBeUndefined();
    expect(invoke(IPC.chatThreadSave, chat, save(), A)).toMatchObject({ id: ID });
    // 🕶 from another window or an unattached mount never latches or deletes the chat's thread.
    emit(IPC.chatIncognito, other, true, A);
    emit(IPC.chatIncognito, chat, true, B);
    expect(row()).toBeDefined();
    emit(IPC.chatIncognito, chat, true, A);
    expect(row()).toBeUndefined();
    expect(invoke(IPC.chatThreadSave, chat, save(), A)).toBeUndefined();
  });

  it("two mounts in one window: separate threads, per-mount incognito, delete refuses both, release frees them", async () => {
    const { row, chat, invoke, emit, delegateTasks, releaseChatSender } = ipcHarness();
    emit(IPC.chatAttach, chat, A);
    emit(IPC.chatAttach, chat, B);
    emit(IPC.chatAttach, chat, A); // already attached: refused, still A's
    expect(invoke(IPC.chatThreadSave, chat, save(), A)).toMatchObject({ id: ID });
    expect(invoke(IPC.chatThreadSave, chat, save([], OTHER), B)).toMatchObject({ id: OTHER });
    expect(() => invoke(IPC.chatThreadSave, chat, save(), B)).toThrow(/different|another open chat/);
    expect(() => invoke(IPC.chatThreadDelete, chat, ID)).toThrow(/open chat/);
    expect(() => invoke(IPC.chatThreadDelete, chat, OTHER)).toThrow(/open chat/);
    // Delegate starts take main's mount key and that chat's live chip — never the renderer's.
    emit(IPC.chatIncognito, chat, true, A);
    expect(row()).toBeUndefined();
    expect(invoke(IPC.chatThreadSave, chat, save([], OTHER), B)).toBeDefined(); // B still saves
    await invoke(IPC.delegateStart, chat, { projectPath: "", prompt: "p", instruction: "i", mountId: B, offRecord: false }, A);
    await invoke(IPC.delegateStart, chat, { projectPath: "", prompt: "p", instruction: "i", offRecord: true }, B);
    expect(delegateTasks.start.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ mountId: A, offRecord: true }),
      expect.objectContaining({ mountId: B, offRecord: false }),
    ]);
    // Release: A's tasks stop, its id is never re-attachable, and a stray release is ignored.
    emit(IPC.chatRelease, chat, A);
    emit(IPC.chatRelease, chat, A);
    expect(delegateTasks.cancelMount.mock.calls).toEqual([[A]]);
    emit(IPC.chatAttach, chat, A);
    expect(() => invoke(IPC.chatThreadSave, chat, save(), A)).toThrow(/unknown chat session/);
    // The window closing releases the rest — B's thread may then be deleted.
    releaseChatSender(chat.id);
    expect(delegateTasks.cancelMount.mock.calls).toEqual([[A], [B]]);
    invoke(IPC.chatThreadDelete, chat, OTHER);
    expect(row(OTHER)).toBeUndefined();
  });

  it("the per-turn memory receipt is tagged with the chat that asked", async () => {
    let n = 0;
    const appended: Memory[][] = [];
    const { chat, invoke, emit } = ipcHarness({
      loadSkills: async () => [], loadProjects: async () => [], loadPersona: async () => ({ name: "Bean", tags: [] }),
      loadMemories: async () => [], loadRoutines: async () => [],
      appendMemories: async (_f, m) => { appended.push(m); },
      converse: async () => ({ content: "nice", toolCalls: [] }),
      extractMemories: async () => ({ candidates: [{ text: `fact ${++n}` }], rejected: 0, failed: false }),
      autoMemory: () => true,
      getModel: () => "m",
      imageGen: undefined, beanDirPath: undefined, actions: [],
    });
    emit(IPC.chatAttach, chat, A);
    await invoke(IPC.chat, chat, { history: [], message: "I live in Seattle", source: "typed", turnId: "item-1" }, A);
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalled());
    expect(chat.send).toHaveBeenCalledWith(IPC.memoryUpdated, [{ id: expect.any(String), text: "fact 1" }], A);
  });

  it("list/delete are chat-window only", () => {
    const { chat, other, invoke } = ipcHarness();
    expect(() => invoke(IPC.chatThreadList, other)).toThrow(/chat window/);
    expect(() => invoke(IPC.chatThreadDelete, other, OTHER)).toThrow(/chat window/);
    expect(invoke(IPC.chatThreadList, chat)).toEqual([]);
  });
});
