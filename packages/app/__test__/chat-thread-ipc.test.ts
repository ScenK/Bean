import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDesktopChat, saveDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats, renameDesktopChatGroup, listDesktopChats, DESKTOP_CHAT_MAX_BYTES } from "@bean/core";
import { buildChatThreadHandlers, registerIpc, type RegisterDeps } from "../src/ipc.js";
import { IPC } from "../src/channels.js";
import type { Memory } from "@bean/core";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() } }));

const ID = "0b6c4a52-1f5e-4c55-9a3e-2c6f0d9e7a10";
const OTHER = "9f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";

function setup() {
  const dbFile = join(mkdtempSync(join(tmpdir(), "bean-thread-")), "bean.db");
  const handlers = buildChatThreadHandlers({ dbFile, saveDesktopChat, getDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats, renameDesktopChatGroup, listDesktopChats });
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

  it("a rename sticks: a later save carrying the old title stores and acks the renamed one", () => {
    const { handlers, row } = setup();
    handlers.save("a", save());
    expect(handlers.rename(ID, "  Renamed\n chat ")).toBe("Renamed chat");
    const ack = handlers.save("a", save([{ kind: "status", id: "item-2", text: "more", tone: "info" }]));
    expect(ack).toMatchObject({ id: ID, title: "Renamed chat" });
    expect(row()).toMatchObject({ title: "Renamed chat" });
    expect(JSON.parse(row()!.itemsJson)[0]).toMatchObject({ text: "more" });
  });

  it("rename validates its arguments and returns undefined for a missing thread", () => {
    const { handlers } = setup();
    expect(() => handlers.rename("../x", "t")).toThrow(/UUID/);
    expect(() => handlers.rename(ID, 3)).toThrow(/string/);
    expect(handlers.rename(ID, "t")).toBeUndefined();
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

  it("stars any thread, open or not; rejects a non-UUID id and a non-boolean flag", () => {
    const { handlers } = setup();
    const ack = handlers.save("a", save());
    expect(handlers.star(ID, true)).toBe(ack!.updatedAt); // the open chat's own thread
    expect(handlers.list()[0]).toMatchObject({ id: ID, starred: true });
    expect(handlers.star(ID, false)).toBe(ack!.updatedAt);
    expect(handlers.list()[0]).toMatchObject({ id: ID, starred: false });
    expect(handlers.star(OTHER, true)).toBeUndefined(); // gone: never inserted
    expect(handlers.list()).toHaveLength(1);
    expect(() => handlers.star("../x", true)).toThrow(/UUID/);
    for (const bad of [1, "true", null, undefined]) expect(() => handlers.star(ID, bad)).toThrow(/boolean/);
    expect(handlers.list()[0]!.starred).toBe(false);
  });

  it("groups any threads (starring them), ungroups with null, renames a group; a save keeps the group", () => {
    const { handlers } = setup();
    handlers.save("a", save());
    handlers.save("b", save([], OTHER));
    expect(handlers.group([ID, OTHER], "Work").sort()).toEqual([ID, OTHER].sort());
    expect(handlers.list().map((t) => [t.starred, t.groupName])).toEqual([[true, "Work"], [true, "Work"]]);
    handlers.save("a", save([]));
    expect(handlers.list().find((t) => t.id === ID)).toMatchObject({ starred: true, groupName: "Work" });
    expect(handlers.group([OTHER], null)).toEqual([OTHER]);
    expect(handlers.list().find((t) => t.id === OTHER)).toMatchObject({ starred: true, groupName: null });
    expect(handlers.groupRename("Work", "Home")).toEqual([ID]);
    expect(handlers.list().find((t) => t.id === ID)!.groupName).toBe("Home");
  });

  it("group refuses bad ids and names; groupRename refuses bad names", () => {
    const { handlers } = setup();
    handlers.save("a", save());
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const bad of [[], ids(101), "x", ["../x"], [ID, 3], [ID, ID], [ID, ID.toUpperCase()]]) {
      expect(() => handlers.group(bad, "G")).toThrow(/UUID|unique/);
    }
    expect(handlers.group(ids(100), "G")).toEqual([]);
    for (const bad of [3, undefined]) expect(() => handlers.group([ID], bad)).toThrow(/string or null/);
    expect(() => handlers.group([ID], " \n ")).toThrow(/empty/);
    expect(() => handlers.groupRename("G", 3)).toThrow(/strings/);
    expect(() => handlers.groupRename("", "G")).toThrow(/empty/);
    expect(handlers.list()[0]).toMatchObject({ starred: false, groupName: null });
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
  const liveTasks = { start: vi.fn(async () => ({ sessionId: "s1", handedOver: 0 })), send: vi.fn(), stop: vi.fn(), interrupt: vi.fn(() => true), resume: vi.fn(), stopMount: vi.fn(), projectOf: vi.fn((): string | undefined => undefined) };
  const terminalTasks = { start: vi.fn(async () => ({ cwd: "/scratch" })), write: vi.fn(), resize: vi.fn(), ack: vi.fn(), stop: vi.fn(async () => {}), stopMount: vi.fn(async () => {}), runningCommand: vi.fn(async () => ["pnpm"]) };
  const all: Partial<RegisterDeps> = { isChatSender: (s) => s === (chat as never), chatThreadHandlers: handlers, delegateTasks, liveTasks, terminalTasks, ...given };
  // Every other dep is a no-op: registration only stores handlers.
  const deps = new Proxy(all, { get: (t, k) => (k in t ? t[k as keyof typeof t] : vi.fn()) }) as RegisterDeps;
  const { releaseChatSender } = registerIpc(ipcMain as never, deps);
  const invoke = (ch: string, sender: unknown, ...args: unknown[]): unknown => handles.get(ch)!({ sender }, ...args);
  const emit = (ch: string, sender: unknown, ...args: unknown[]): unknown => ons.get(ch)!({ sender }, ...args);
  return { handlers, row, chat, other, delegateTasks, liveTasks, terminalTasks, releaseChatSender, invoke, emit };
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

  it("terminal calls need the chat window and an attached mount; release and window close stop every tab", async () => {
    const { chat, other, invoke, emit, terminalTasks, releaseChatSender } = ipcHarness();
    const openExternal = vi.mocked((await import("electron")).shell.openExternal);
    const T = "d0000000-0000-4000-8000-000000000001";
    emit(IPC.chatAttach, chat, A);
    emit(IPC.chatAttach, chat, B);
    expect(await invoke(IPC.terminalStart, other, "", 80, 24, A, T)).toEqual({ error: expect.stringMatching(/chat window/) });
    expect(await invoke(IPC.terminalStart, chat, "", 80, 24, "c0000000-0000-4000-8000-000000000003", T)).toEqual({ error: expect.stringMatching(/chat window/) });
    emit(IPC.terminalWrite, other, "rm -rf ~\r", A, T);
    emit(IPC.terminalResize, other, 100, 30, A, T);
    emit(IPC.terminalAck, other, 10, A, T);
    await invoke(IPC.terminalStop, other, A, T);
    await invoke(IPC.terminalStop, other, A);
    emit(IPC.terminalOpenLink, other, "https://example.com", A);
    expect([terminalTasks.start, terminalTasks.write, terminalTasks.resize, terminalTasks.ack, terminalTasks.stop, terminalTasks.stopMount, openExternal]
      .map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await invoke(IPC.terminalStart, chat, "/proj", 80, 24, A, T)).toEqual({ cwd: "/scratch" });
    expect(terminalTasks.start.mock.calls).toEqual([[{ senderId: chat.id, mountId: A }, T, "/proj", 80, 24]]);
    emit(IPC.terminalWrite, chat, "ls\r", A, T);
    emit(IPC.terminalResize, chat, 100, 30, A, T);
    emit(IPC.terminalAck, chat, 10, A, T);
    emit(IPC.terminalOpenLink, chat, "file:///etc/passwd", A);
    emit(IPC.terminalOpenLink, chat, "https://example.com", A);
    expect([terminalTasks.write.mock.calls, terminalTasks.resize.mock.calls, terminalTasks.ack.mock.calls])
      .toEqual([[[A, T, "ls\r"]], [[A, T, 100, 30]], [[A, T, 10]]]);
    expect(await invoke(IPC.terminalRunning, other, A)).toEqual([]);
    expect(await invoke(IPC.terminalRunning, chat, A)).toEqual(["pnpm"]);
    await invoke(IPC.terminalRunning, chat, A, T);
    expect(terminalTasks.runningCommand.mock.calls).toEqual([[A, undefined], [A, T]]);
    expect(openExternal.mock.calls).toEqual([["https://example.com/"]]);
    // A tab stops alone; no tab stops the whole chat.
    await invoke(IPC.terminalStop, chat, A, T);
    await invoke(IPC.terminalStop, chat, A);
    expect([terminalTasks.stop.mock.calls, terminalTasks.stopMount.mock.calls]).toEqual([[[A, T]], [[A]]]);
    // A released mount is stale: every tab stops and later calls are refused.
    emit(IPC.chatRelease, chat, A);
    expect(terminalTasks.stopMount.mock.calls).toEqual([[A], [A]]);
    emit(IPC.terminalWrite, chat, "ls\r", A, T);
    expect(terminalTasks.write.mock.calls).toHaveLength(1);
    releaseChatSender(chat.id);
    expect(terminalTasks.stopMount.mock.calls).toEqual([[A], [A], [B]]);
  });

  it("chatOpenPath: only the owning chat, validated in main, relative paths only against the chat's live project", async () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "bean-open-")));
    const { chat, other, emit, liveTasks } = ipcHarness({ getEditorApp: () => "", getTerminalApp: () => "" });
    const { shell } = await import("electron");
    const reveal = vi.mocked(shell.showItemInFolder);
    const openPath = vi.mocked(shell.openPath);
    reveal.mockClear();
    openPath.mockClear();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    emit(IPC.chatAttach, chat, A);
    liveTasks.projectOf.mockImplementation((m: string) => (m === A ? proj : undefined));
    emit(IPC.chatOpenPath, other, proj, A); // not the chat window
    emit(IPC.chatOpenPath, chat, proj, B); // a mount this window doesn't own
    emit(IPC.chatOpenPath, chat, `file://${proj}`, A); // a URI scheme
    emit(IPC.chatOpenPath, chat, join(proj, "missing.md"), A); // missing = no-op
    await settle();
    expect([reveal.mock.calls.length, openPath.mock.calls.length]).toEqual([0, 0]);
    emit(IPC.chatOpenPath, chat, `${proj}:3`, A);
    emit(IPC.chatOpenPath, chat, ".", A); // relative, against the live project
    await settle();
    expect(openPath.mock.calls).toEqual([[proj], [proj]]);
    expect(liveTasks.projectOf.mock.calls.every(([m]) => m === A)).toBe(true);
    // A file with no editor set is revealed, never opened.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(proj, "a.sh"), "echo hi");
    emit(IPC.chatOpenPath, chat, "a.sh", A);
    await settle();
    expect(reveal.mock.calls).toEqual([[join(proj, "a.sh")]]);
  });

  it("two mounts in one window: separate threads, per-mount incognito, delete refuses both, release frees them", async () => {
    const { row, chat, other, invoke, emit, delegateTasks, liveTasks, releaseChatSender } = ipcHarness();
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
    // Live sessions are owned by (window, mount); an unattached mount or another window is refused.
    await invoke(IPC.liveStart, chat, { agent: "claude" }, B);
    expect(await invoke(IPC.liveStart, chat, { agent: "claude" }, "not-a-uuid")).toEqual({ error: expect.stringMatching(/chat window/) });
    expect(await invoke(IPC.liveStart, other, { agent: "claude" }, B)).toEqual({ error: expect.stringMatching(/chat window/) });
    emit(IPC.liveStop, chat, "s1", B);
    expect(liveTasks.start.mock.calls).toEqual([[{ senderId: chat.id, mountId: B }, { agent: "claude" }]]);
    expect(liveTasks.stop.mock.calls).toEqual([[{ senderId: chat.id, mountId: B }, "s1"]]);
    // Stop / Esc Esc: same ownership gate; refused senders and mounts never reach live-tasks.
    expect(invoke(IPC.liveInterrupt, other, "s1", B, 0)).toBe(false);
    expect(invoke(IPC.liveInterrupt, chat, "s1", "not-a-uuid", 0)).toBe(false);
    expect(invoke(IPC.liveInterrupt, chat, "s1", B, 2)).toBe(true);
    expect(liveTasks.interrupt.mock.calls).toEqual([[{ senderId: chat.id, mountId: B }, "s1", 2]]);
    // Release: A's tasks stop, its id is never re-attachable, and a stray release is ignored.
    emit(IPC.chatRelease, chat, A);
    emit(IPC.chatRelease, chat, A);
    expect(delegateTasks.cancelMount.mock.calls).toEqual([[A]]);
    expect(liveTasks.stopMount.mock.calls).toEqual([[A]]);
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

  // #740: Stop / Esc Esc for Bean's own turn. The model call never answers, so only an abort ends it.
  function hangingChat() {
    const extractMemories = vi.fn(async () => ({ candidates: [{ text: "fact" }], rejected: 0, failed: false }));
    const ended: unknown[] = [];
    const h = ipcHarness({
      loadSkills: async () => [], loadProjects: async () => [], loadPersona: async () => ({ name: "Bean", tags: [] }),
      loadMemories: async () => [], loadRoutines: async () => [],
      converse: () => new Promise(() => {}),
      extractMemories, autoMemory: () => true, getModel: () => "m",
      onChatTurn: () => (error?: string) => { ended.push(error); },
      imageGen: undefined, beanDirPath: undefined, actions: [],
    });
    h.emit(IPC.chatAttach, h.chat, A);
    h.emit(IPC.chatAttach, h.chat, B);
    const turn = (mount: string, turnId: string) =>
      h.invoke(IPC.chat, h.chat, { history: [], message: "I live in Seattle", source: "typed", turnId }, mount) as Promise<{ stopped?: true; error?: string }>;
    return { ...h, extractMemories, ended, turn };
  }

  it("chatStop aborts only its own mount's running turn; a stopped turn raises no error and captures nothing", async () => {
    const { chat, other, emit, turn, ended, extractMemories } = hangingChat();
    let settled = false;
    const running = turn(A, "t1").finally(() => { settled = true; });
    emit(IPC.chatStop, other, A, "t1"); // not the chat window
    emit(IPC.chatStop, chat, B, "t1"); // another chat's mount
    emit(IPC.chatStop, chat, A, "t0"); // a stale turn id
    emit(IPC.chatStop, chat, A); // no turn id
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    emit(IPC.chatStop, chat, A, "t1");
    expect(await running).toMatchObject({ reply: "", stopped: true });
    expect(ended).toEqual([undefined]);
    await new Promise((r) => setTimeout(r, 20));
    expect(extractMemories).not.toHaveBeenCalled();
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("releasing a chat aborts its running turn", async () => {
    const { chat, emit, turn, releaseChatSender } = hangingChat();
    const a = turn(A, "t1");
    const b = turn(B, "t2");
    emit(IPC.chatRelease, chat, A);
    expect(await a).toMatchObject({ stopped: true });
    releaseChatSender(chat.id);
    expect(await b).toMatchObject({ stopped: true });
  });

  it("list/delete/star/rename/group are chat-window only", () => {
    const { chat, other, invoke } = ipcHarness();
    expect(() => invoke(IPC.chatThreadList, other)).toThrow(/chat window/);
    expect(() => invoke(IPC.chatThreadDelete, other, OTHER)).toThrow(/chat window/);
    expect(() => invoke(IPC.chatThreadStar, other, OTHER, true)).toThrow(/chat window/);
    expect(invoke(IPC.chatThreadStar, chat, OTHER, true)).toBeUndefined();
    expect(() => invoke(IPC.chatThreadRename, other, OTHER, "t")).toThrow(/chat window/);
    expect(invoke(IPC.chatThreadRename, chat, OTHER, "t")).toBeUndefined();
    expect(() => invoke(IPC.chatThreadGroup, other, [OTHER], "G")).toThrow(/chat window/);
    expect(invoke(IPC.chatThreadGroup, chat, [OTHER], "G")).toEqual([]);
    expect(() => invoke(IPC.chatThreadGroupRename, other, "G", "H")).toThrow(/chat window/);
    expect(invoke(IPC.chatThreadGroupRename, chat, "G", "H")).toEqual([]);
    expect(invoke(IPC.chatThreadList, chat)).toEqual([]);
  });
  it("chatStageImage stages to a private file and rejects a bad mime, an oversize payload and an unattached mount", async () => {
    const { chat, other, invoke, emit } = ipcHarness();
    emit(IPC.chatAttach, chat, A);
    const data = Buffer.from("img").toString("base64");
    await expect(invoke(IPC.chatStageImage, chat, data, "image/png", B)).rejects.toThrow(/unknown chat session/);
    await expect(invoke(IPC.chatStageImage, other, data, "image/png", A)).rejects.toThrow(/chat window/);
    await expect(invoke(IPC.chatStageImage, chat, data, "image/gif", A)).rejects.toThrow(/PNG, JPEG and WebP/);
    await expect(invoke(IPC.chatStageImage, chat, "A".repeat(14_000_000), "image/png", A)).rejects.toThrow(/10 MB/);
    const path = await invoke(IPC.chatStageImage, chat, data, "image/png", A) as string;
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("img");
  });
});
