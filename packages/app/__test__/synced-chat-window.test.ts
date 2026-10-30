// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

// #530: the owner's Discord/Teams conversations in the history sidebar — a read view plus desk
// turns through the bot; never desktop history, incognito or memory.
describe("ChatWindow synced chats", () => {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;
  const now = new Date().toISOString();
  const dm = { surface: "discord", conversationId: "d1", kind: "dm", title: "DM", updatedAt: now, live: false };
  const post = { surface: "teams", conversationId: "t1", kind: "post", title: "Standup", updatedAt: now, live: true, liveCli: "claude" };

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const synced = (): Element => root.querySelector(".bean-chat--synced")!;
  const composer = (): HTMLTextAreaElement => synced().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
  const openRow = async (text: string): Promise<void> => {
    const row = [...root.querySelectorAll(".bean-chat-sidebar-row")].find((r) => r.textContent?.includes(text));
    await act(async () => { (row!.querySelector(".bean-chat-sidebar-open") as HTMLElement).click(); });
    await flush();
  };
  const send = async (text: string): Promise<void> => {
    const ta = composer();
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  const mount = async (): Promise<void> => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
  };

  beforeEach(() => {
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chatThreadList: vi.fn(async () => []),
      syncedChatList: vi.fn(async () => [dm, post]),
      syncedChatGet: vi.fn(async () => [{ role: "user", text: "from my phone" }, { role: "bean", text: "**hi** back" }]),
      syncedChatSend: vi.fn(async () => ({ ok: true })),
      chatopsStatus: vi.fn(async () => ({ discord: { running: true, enabled: true }, teams: { running: true, enabled: true } })),
      chatAttach: vi.fn(),
      chatRelease: vi.fn(),
      chatThreadSave: vi.fn(),
      rememberOnClose: vi.fn(),
      setChatIncognito: vi.fn(),
      chat: vi.fn(),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (...a: unknown[]) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("lists synced rows with their badge, opens the transcript, and sends a desk turn", async () => {
    await mount();
    expect(root.querySelector(".bean-chat-sidebar")!.textContent).toContain("Discord");
    expect(root.querySelector(".bean-chat-sidebar")!.textContent).toContain("Standup · live");
    await openRow("DM");
    const mountId = bean.chatAttach!.mock.calls.at(-1)![0];
    expect(bean.syncedChatGet).toHaveBeenCalledWith("discord", "d1", mountId);
    expect(synced().textContent).toContain("from my phone");
    expect(synced().querySelector("strong")?.textContent).toBe("hi");
    expect(composer().placeholder).toBe("Message Bean");
    expect(synced().textContent).toContain("Cards, approvals and memory receipts stay in Discord.");
    // The desktop chat underneath is hidden, not replaced.
    expect(root.querySelector(".bean-chat:not([hidden]):not(.bean-chat--synced)")).toBeNull();

    await send("from the desk");
    expect(bean.syncedChatSend).toHaveBeenCalledWith("discord", "d1", "from the desk", mountId);
    expect(synced().textContent).toContain("from the desk");
    // Never desktop history, incognito, memory or a Bean turn of its own.
    expect(bean.chatThreadSave).not.toHaveBeenCalled();
    expect(bean.rememberOnClose).not.toHaveBeenCalled();
    expect(bean.setChatIncognito).not.toHaveBeenCalled();
    expect(bean.chat).not.toHaveBeenCalled();
  });

  it("a refused or unanswered turn becomes an error row", async () => {
    bean.syncedChatSend!.mockResolvedValueOnce({ refused: "post-failed" }).mockResolvedValueOnce({ failed: "discord bot didn't answer" });
    await mount();
    await openRow("DM");
    await send("one");
    expect(synced().querySelector(".bean-status--error")?.textContent).toBe("Couldn't post the message there — nothing was sent.");
    await send("two");
    expect(synced().textContent).toContain("Not confirmed by the Discord bot (discord bot didn't answer). Check Discord before sending again.");
    expect(synced().querySelector(".bean-bubble--pending")).toBeNull();
  });

  it("composer states: live steers, an ended session says so, bot down is read-only", async () => {
    await mount();
    await openRow("Standup");
    expect(composer().placeholder).toBe("Steer the live session…");
    expect(composer().disabled).toBe(false);

    bean.syncedChatList!.mockResolvedValue([dm, { ...post, live: false }]);
    await act(async () => { listeners.onSyncedChatEvent!({ surface: "teams", conversationId: "t1" }); });
    await flush();
    expect(composer().placeholder).toBe("Session ended — Continue live, or message Bean");

    await act(async () => { listeners.onChatopsEvent!({ bot: "teams", running: false, enabled: true }); });
    await flush();
    expect(composer().disabled).toBe(true);
    expect(synced().textContent).toContain("The Teams bot isn't running");
    await send("ignored");
    expect(bean.syncedChatSend).not.toHaveBeenCalled();
  });

  it("a saved ping re-reads the shown chat and marks another one unread", async () => {
    await mount();
    await openRow("DM");
    const reads = bean.syncedChatGet!.mock.calls.length;
    await act(async () => { listeners.onSyncedChatEvent!({ surface: "discord", conversationId: "d1", saved: true }); });
    await flush();
    expect(bean.syncedChatGet!.mock.calls.length).toBe(reads + 1);
    await act(async () => { listeners.onSyncedChatEvent!({ surface: "teams", conversationId: "t1", saved: true }); });
    await flush();
    const row = [...root.querySelectorAll(".bean-chat-sidebar-row")].find((r) => r.textContent?.includes("Standup"))!;
    expect(row.querySelector(".bean-chat-sidebar-dot")).not.toBeNull();
  });

  it("Continue live: shown on an ended recorded session, Opening… until live, one request for a double click", async () => {
    let ack!: (r: unknown) => void;
    bean.syncedChatResume = vi.fn(() => new Promise((r) => { ack = r; }));
    bean.syncedChatList!.mockResolvedValue([dm, { ...post, live: false, resumable: true }]);
    await mount();
    await openRow("DM");
    expect(synced().textContent).not.toContain("Continue live");
    await openRow("Standup");
    const button = (): HTMLButtonElement | undefined =>
      [...synced().querySelectorAll("button.bean-status-action")].find((b) => /Continue live|Opening/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
    expect(button()?.textContent).toBe("Continue live");
    const mountId = bean.chatAttach!.mock.calls.at(-1)![0];

    await act(async () => { button()!.click(); button()!.click(); });
    await flush();
    expect(bean.syncedChatResume).toHaveBeenCalledTimes(1);
    expect(bean.syncedChatResume).toHaveBeenCalledWith("teams", "t1", mountId);
    expect(button()?.textContent).toBe("Opening…");
    expect(button()?.disabled).toBe(true);
    await act(async () => { ack({ ok: true }); });
    await flush();
    expect(button()?.textContent).toBe("Opening…");

    // The bot's `live start` lands: hidden while live.
    bean.syncedChatList!.mockResolvedValue([dm, { ...post, live: true, resumable: true }]);
    await act(async () => { listeners.onSyncedChatEvent!({ surface: "teams", conversationId: "t1" }); });
    await flush();
    expect(button()).toBeUndefined();
    expect(composer().placeholder).toBe("Steer the live session…");
  });

  it("a refused Continue live becomes an error row and the button comes back", async () => {
    bean.syncedChatResume = vi.fn(async () => ({ refused: "channel-busy" }));
    bean.syncedChatList!.mockResolvedValue([dm, { ...post, live: false, resumable: true }]);
    await mount();
    await openRow("Standup");
    const button = synced().querySelector("button.bean-status-action") as HTMLButtonElement;
    await act(async () => { button.click(); });
    await flush();
    expect(synced().querySelector(".bean-status--error")?.textContent).toBe("A live session is already running there.");
    expect((synced().querySelector("button.bean-status-action") as HTMLButtonElement).textContent).toBe("Continue live");
  });
});

