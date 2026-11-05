// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";
import { expirePending } from "../src/renderer/components/chat/ChatSession.js";
import type { ChatItem } from "../src/renderer/shared/chat-types.js";

// #697: Continue in Discord from the chat header — a close while the bot's ack is pending waits for
// it, so the pointer is saved; cards still awaiting a tap expire once the chat moved.
describe("Continue in Discord", () => {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;
  let ack!: (r: unknown) => void;

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const shownChat = (): Element => root.querySelector(".bean-chat:not([hidden])")!;
  const click = async (el: Element | null | undefined): Promise<void> => {
    if (!el) throw new Error("no element");
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };
  const send = async (text: string): Promise<void> => {
    const ta = shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  const lastSaved = (): ChatItem[] => (bean.chatThreadSave!.mock.calls.at(-1)![0] as { items: ChatItem[] }).items;

  beforeEach(() => {
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } })),
      chatThreadList: vi.fn(async () => []),
      chatThreadSave: vi.fn(async (req: { id: string; title: string }) => ({ id: req.id, title: req.title, updatedAt: new Date().toISOString() })),
      chatopsStatus: vi.fn(async () => ({ discord: { running: true }, teams: { running: false } })),
      destinationsList: vi.fn(async () => [{ surface: "discord", conversationId: "c1", kind: "channel", label: "general", usedBy: [], lastSeen: "" }]),
      deskContinue: vi.fn(() => new Promise((r) => { ack = r; })),
      syncedChatList: vi.fn(async () => []),
      allowChatClose: vi.fn(),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (...a: unknown[]) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("a window close during a pending continue waits for the ack and saves the pointer with expired cards", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("audit the repo");
    await click(shownChat().querySelector(".bean-chat-continue"));
    await click([...root.querySelectorAll(".bean-continue-card button")].find((b) => b.textContent === "Continue in Discord"));
    expect(bean.deskContinue).toHaveBeenCalledTimes(1);
    expect(bean.deskContinue!.mock.calls[0]![0]).toMatchObject({ channelId: "c1", title: "audit the repo", history: expect.any(Array) });

    await act(async () => { listeners.onReviewBeforeClose!(); });
    await flush();
    expect(bean.allowChatClose).not.toHaveBeenCalled(); // waiting on the bot

    await act(async () => { ack({ ok: true, threadId: "th-1" }); });
    await flush();
    expect(bean.allowChatClose).toHaveBeenCalledTimes(1);
    const items = lastSaved();
    expect(items.at(-1)).toMatchObject({ kind: "continued", surface: "discord", conversationId: "th-1", title: "audit the repo" });
    expect(items.find((it) => it.kind === "delegate")).toMatchObject({ state: "expired" });
    expect(shownChat().querySelector("textarea.bean-input--composer")).toBeNull();
  });

  it("expirePending leaves finished cards and receipts alone", () => {
    const items = [
      { kind: "todo", id: "a", todo: { routine: "r", text: "t" }, state: "pending" },
      { kind: "todo", id: "b", todo: { routine: "r", text: "t" }, state: "queued" },
      { kind: "memory", id: "c", saved: [], state: "saved" },
    ] as unknown as ChatItem[];
    expect(expirePending(items).map((it) => ("state" in it ? it.state : undefined))).toEqual(["expired", "queued", "saved"]);
  });
});
