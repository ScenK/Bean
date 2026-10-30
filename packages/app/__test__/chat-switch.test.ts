// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

// #516: the history sidebar switches chats inside the one window — evict (save, memory, release),
// then mount the pick with a new mount id.
describe("ChatWindow switches chats in place", () => {
  const OTHER = "9f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const calls: string[] = [];
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const send = async (text: string): Promise<void> => {
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  const clickEl = async (el: Element | null | undefined): Promise<void> => {
    if (!el) throw new Error("no element");
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };
  const otherRow = (): Element | undefined => [...root.querySelectorAll(".bean-chat-sidebar-open")].find((b) => b.textContent?.includes("other chat"));
  const mounts = (ch: string): string[] => bean[ch]!.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    calls.length = 0;
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => []),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "first reply", model: "m" })),
      chatThreadList: vi.fn(async () => [{ id: OTHER, title: "other chat", updatedAt: new Date().toISOString(), agents: [] }]),
      chatThreadSave: vi.fn(async (req: { id: string; title: string }) => ({ id: req.id, title: req.title, updatedAt: new Date().toISOString() })),
      chatThreadGet: vi.fn(async () => ({ id: OTHER, title: "other chat", items: [{ kind: "reply", id: "item-1", text: "restored reply" }], noteSlug: null })),
      chatAttach: vi.fn((m: string) => { calls.push(`attach ${m}`); }),
      chatRelease: vi.fn((m: string) => { calls.push(`release ${m}`); }),
      rememberOnClose: vi.fn((_t: unknown, o: { mountId: string }) => { calls.push(`remember ${o.mountId}`); }),
      allowChatClose: vi.fn(),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (...a: unknown[]) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("evicts the shown chat (final save, memory, release) and restores the pick under a new mount", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    expect(root.textContent).toContain("first reply");
    expect(bean.chat!.mock.calls[0]![1]).toBe(first);

    await clickEl(otherRow());
    const second = mounts("chatAttach")[1]!;
    expect(second).not.toBe(first);
    expect(calls).toEqual([`attach ${first}`, `remember ${first}`, `release ${first}`, `attach ${second}`]);
    expect(bean.chatThreadSave!.mock.calls.every((c) => c[1] === first)).toBe(true);
    expect(bean.chatThreadGet).toHaveBeenCalledWith(OTHER, second);
    expect(root.textContent).toContain("restored reply");
    expect(root.textContent).not.toContain("first reply");
    expect(document.activeElement).toBe(root.querySelector("textarea.bean-input--composer"));

    // A late receipt from the evicted chat never lands in this one; this chat's own does.
    await act(async () => { listeners.onMemoryUpdated!([{ id: "m1", text: "old fact" }], first); });
    expect(root.querySelector(".bean-memory")).toBeNull();
    await act(async () => { listeners.onMemoryUpdated!([{ id: "m2", text: "new fact" }], second); });
    expect(root.textContent).toContain("new fact");
  });

  it("a failed final save keeps the chat mounted", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("hello there");
    bean.chatThreadSave!.mockRejectedValue(new Error("disk full"));
    await send("one more");
    await clickEl(otherRow());
    expect(bean.chatRelease).not.toHaveBeenCalled();
    expect(bean.chatAttach).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Couldn't save this chat");
    expect(root.textContent).toContain("one more");
  });

  it("the composer is blocked while the switch-away save is in flight — nothing typed then is lost", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("hello there");
    let ack: () => void = () => {};
    bean.chatThreadSave!.mockImplementationOnce((req: { id: string; title: string }) => new Promise((resolve) => {
      ack = () => resolve({ id: req.id, title: req.title, updatedAt: new Date().toISOString() });
    }));
    await send("one more"); // its reply queues the delayed write
    await clickEl(otherRow());
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    await send("typed during the save");
    expect(bean.chat).toHaveBeenCalledTimes(2);
    expect(ta.value).toBe("typed during the save"); // the draft stays put
    await act(async () => { ack(); });
    await flush();
    expect(bean.chatThreadGet).toHaveBeenCalledWith(OTHER, expect.any(String));
  });

  it("a receipt that lands after its chat was switched away comes back, Undo included, when that chat is reopened", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    const thread = (bean.chatThreadSave!.mock.calls[0]![0] as { id: string }).id;
    await clickEl(otherRow());
    await act(async () => { listeners.onMemoryUpdated!([{ id: "m1", text: "old fact" }], first); });
    expect(root.textContent).not.toContain("old fact");

    bean.chatThreadGet!.mockResolvedValueOnce({ id: thread, title: "hello there", items: [{ kind: "user", id: "item-1", text: "hello there" }], noteSlug: null });
    await clickEl([...root.querySelectorAll(".bean-chat-sidebar-open")].find((b) => b.textContent?.includes("hello there")));
    expect(root.textContent).toContain("old fact");
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Undo")).toBe(true);
    // ...and it's saved into that thread like any new row.
    await vi.waitFor(() => {
      const last = bean.chatThreadSave!.mock.calls.at(-1)![0] as { id: string; items: Array<{ kind: string }> };
      expect(last.id).toBe(thread);
      expect(last.items.some((it) => it.kind === "memory")).toBe(true);
    });
  });

  it("New chat on an untouched empty chat does nothing; on a used one it mounts an empty chat", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await clickEl(root.querySelector(".bean-chat-sidebar-new"));
    expect(bean.chatRelease).not.toHaveBeenCalled();
    await send("hello there");
    await clickEl(root.querySelector(".bean-chat-sidebar-new"));
    expect(bean.chatRelease).toHaveBeenCalledTimes(1);
    expect(bean.chatAttach).toHaveBeenCalledTimes(2);
    expect(bean.chatThreadGet).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".bean-bubble")).toHaveLength(0);
  });
});
