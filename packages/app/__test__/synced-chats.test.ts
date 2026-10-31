import { describe, expect, it, vi } from "vitest";
import { formatSummaryBlock, MAX_DESK_TEXT, speakerLine, type ChatopsConversation } from "@bean/core";
import { buildSyncedChatHandlers, mapSyncedTranscript, type SyncedChatHandlerDeps } from "../src/synced-chats.js";
import { registerIpc, type RegisterDeps } from "../src/ipc.js";
import { IPC } from "../src/channels.js";
import { MAX_DESK_TEXT as RENDERER_MAX } from "../src/renderer/components/chat/SyncedChat.js";

describe("mapSyncedTranscript", () => {
  const turns = [
    { role: "user" as const, content: formatSummaryBlock("they talked about builds") },
    { role: "user" as const, content: speakerLine("Scen", "deploy it") },
    { role: "assistant" as const, content: "On it." },
    { role: "user" as const, content: speakerLine("Ana", "me too") },
    { role: "user" as const, content: "[Recent channel messages, for context …]\nAna: hi" },
    { role: "assistant" as const, content: "[live session] Deployed." },
    { role: "assistant" as const, content: "[delegate result] tests pass" },
  ];

  it("drops the owner's prefix, keeps other speakers, maps live finals and the summary", () => {
    expect(mapSyncedTranscript(turns, { kind: "thread", liveCli: "codex" }, "Scen")).toEqual([
      { role: "status", text: "Earlier messages were summarized." },
      { role: "user", text: "deploy it" },
      { role: "bean", text: "On it." },
      { role: "user", text: "me too", name: "Ana" },
      { role: "agent", text: "Deployed.", agent: "codex" },
      { role: "bean", text: "[delegate result] tests pass" },
    ]);
  });

  it("a DM is all the owner's, whatever name the platform gave", () => {
    const rows = mapSyncedTranscript([{ role: "user", content: speakerLine("Scen K", "hi") }], { kind: "dm" }, "the owner");
    expect(rows).toEqual([{ role: "user", text: "hi" }]);
  });

  it("the renderer's text cap matches core's", () => {
    expect(RENDERER_MAX).toBe(MAX_DESK_TEXT);
  });
});

const ROWS: ChatopsConversation[] = [
  { conversationId: "d1", surface: "discord", kind: "dm", title: "DM", ownerId: "u1", updatedAt: "2026-10-30T10:00:00.000Z" },
  { conversationId: "t1", surface: "teams", kind: "post", title: "Standup", ownerId: "29:x", liveCli: "claude", liveSessionId: "sess-1", updatedAt: "2026-10-30T09:00:00.000Z" },
];

function handlers(given: Partial<SyncedChatHandlerDeps> = {}) {
  const deps: SyncedChatHandlerDeps = {
    dbFile: "/db",
    owners: async () => [{ surface: "discord", ownerId: "u1", ownerName: "Scen" }, { surface: "teams", ownerId: "29:x", ownerName: "Scen" }],
    listConversations: vi.fn(() => ROWS),
    conversationTurns: vi.fn(() => [{ role: "user" as const, content: speakerLine("Scen", "hello") }]),
    liveIds: (s) => new Set(s === "teams" ? ["t1"] : []),
    deskTurn: vi.fn(async () => ({ ok: true as const })),
    deskResume: vi.fn(async () => ({ ok: true as const })),
    ...given,
  };
  return { deps, h: buildSyncedChatHandlers(deps) };
}

describe("buildSyncedChatHandlers", () => {
  it("lists the current owner's rows with live state, without owner ids", async () => {
    const { h, deps } = handlers();
    const list = await h.list();
    expect(list).toEqual([
      { surface: "discord", conversationId: "d1", kind: "dm", title: "DM", updatedAt: ROWS[0]!.updatedAt, live: false, resumable: false },
      { surface: "teams", conversationId: "t1", kind: "post", title: "Standup", updatedAt: ROWS[1]!.updatedAt, live: true, liveCli: "claude", resumable: true },
    ]);
    expect(deps.listConversations).toHaveBeenCalledWith("/db", expect.arrayContaining([expect.objectContaining({ surface: "teams", ownerId: "29:x" })]));
  });

  it("reads and sends only listed conversations", async () => {
    const { h, deps } = handlers();
    await expect(h.get("discord", "d1")).resolves.toEqual([{ role: "user", text: "hello" }]);
    await expect(h.get("discord", "t1")).rejects.toThrow(/not a synced chat/);
    await expect(h.get("slack", "d1")).rejects.toThrow(/malformed/);
    await expect(h.send("teams", "nope", "hi")).rejects.toThrow(/not a synced chat/);
    await expect(h.send("discord", "d1", "  ")).rejects.toThrow(/empty/);
    expect(deps.deskTurn).not.toHaveBeenCalled();
  });

  it("refuses an over-long text before the bot, passes acks through, and reports a missing ack", async () => {
    const deskTurn = vi.fn()
      .mockResolvedValueOnce({ refused: "queue-full" })
      .mockRejectedValueOnce(new Error("discord bot is not running"));
    const { h } = handlers({ deskTurn });
    await expect(h.send("discord", "d1", "x".repeat(MAX_DESK_TEXT + 1))).resolves.toEqual({ refused: "too-long" });
    expect(deskTurn).not.toHaveBeenCalled();
    await expect(h.send("discord", "d1", "hi")).resolves.toEqual({ refused: "queue-full" });
    expect(deskTurn).toHaveBeenCalledWith("discord", "d1", "hi");
    await expect(h.send("discord", "d1", "hi")).resolves.toEqual({ failed: "discord bot is not running" });
  });

  it("Continue live sends only the conversation id, for a listed row with a recorded session", async () => {
    const deskResume = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("teams bot didn't answer"));
    const { h } = handlers({ deskResume });
    await expect(h.resume("discord", "d1")).resolves.toEqual({ refused: "no-record" });
    await expect(h.resume("discord", "t1")).rejects.toThrow(/not a synced chat/);
    expect(deskResume).not.toHaveBeenCalled();
    await expect(h.resume("teams", "t1")).resolves.toEqual({ ok: true });
    expect(deskResume).toHaveBeenCalledWith("teams", "t1");
    await expect(h.resume("teams", "t1")).resolves.toEqual({ failed: "teams bot didn't answer" });
  });
});

describe("synced chat IPC", () => {
  const A = "a0000000-0000-4000-8000-000000000001";
  const B = "b0000000-0000-4000-8000-000000000002";

  it("needs the chat window, and a mount attached to it for a transcript or a send", async () => {
    const handles = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
    const ons = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handles.set(ch, fn); },
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { ons.set(ch, fn); },
    };
    const { h, deps: sDeps } = handlers();
    const chat = { id: 1 }, other = { id: 2 };
    const all: Partial<RegisterDeps> = { isChatSender: (s) => s === (chat as never), syncedChatHandlers: h };
    const deps = new Proxy(all, { get: (t, k) => (k in t ? t[k as keyof typeof t] : vi.fn()) }) as RegisterDeps;
    registerIpc(ipcMain as never, deps);
    const invoke = (ch: string, sender: unknown, ...args: unknown[]): unknown => handles.get(ch)!({ sender }, ...args);
    ons.get(IPC.chatAttach)!({ sender: chat }, A);

    expect(() => invoke(IPC.syncedChatList, other)).toThrow(/chat window/);
    await expect(invoke(IPC.syncedChatList, chat)).resolves.toHaveLength(2);
    expect(() => invoke(IPC.syncedChatGet, other, "discord", "d1", A)).toThrow(/chat window/);
    expect(() => invoke(IPC.syncedChatGet, chat, "discord", "d1", B)).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.syncedChatSend, chat, "discord", "d1", "hi", B)).toThrow(/unknown chat session/);
    expect(sDeps.deskTurn).not.toHaveBeenCalled();
    await expect(invoke(IPC.syncedChatGet, chat, "discord", "d1", A)).resolves.toHaveLength(1);
    await expect(invoke(IPC.syncedChatSend, chat, "discord", "d1", "hi", A)).resolves.toEqual({ ok: true });
    expect(() => invoke(IPC.syncedChatResume, chat, "teams", "t1", B)).toThrow(/unknown chat session/);
    expect(() => invoke(IPC.syncedChatResume, other, "teams", "t1", A)).toThrow(/chat window/);
    expect(sDeps.deskResume).not.toHaveBeenCalled();
    await expect(invoke(IPC.syncedChatResume, chat, "teams", "t1", A)).resolves.toEqual({ ok: true });
  });
});
