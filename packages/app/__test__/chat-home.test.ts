// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

// #960: today's Home — the pinned row opens it, its pending posts are appended once (no model turn)
// and drained by the save that holds them; a hidden Home waits until it's shown.
describe("ChatWindow Home", () => {
  const HOME = "4f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;
  const now = new Date().toISOString();
  const posts = [
    { id: "p1", sprout: "digest", body: "**3** PRs merged", createdAt: now },
    { id: "p2", sprout: "inbox", body: '[card: run "deploy" — started]', createdAt: now },
  ];
  const homeThread = (p = posts) => ({ id: HOME, title: "Home · Nov 19", items: [], noteSlug: null, home: { posts: p, until: new Date(Date.now() + 3_600_000).toISOString() } });

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const shownChat = (): Element => root.querySelector(".bean-chat:not([hidden])")!;
  const click = async (el: Element | null | undefined): Promise<void> => {
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };
  const homeRow = (): Element | null => root.querySelector(".bean-chat-sidebar-home .bean-chat-sidebar-open");
  const send = async (text: string): Promise<void> => {
    const ta = shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  // The post ids each save holds (main drains the handed ones it finds there).
  const savedPosts = (call = -1): string[] => ((bean.chatThreadSave!.mock.calls.at(call)?.[0] as { items?: Array<{ kind: string; postId?: string }> } | undefined)?.items ?? [])
    .flatMap((it) => (it.kind === "post" ? [it.postId!] : []));

  beforeEach(() => {
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "noted", model: "m" })),
      chatThreadList: vi.fn(async () => []),
      syncedChatList: vi.fn(async () => [{ surface: "discord", conversationId: "d1", kind: "dm", title: "DM", updatedAt: now, live: false }]),
      syncedChatGet: vi.fn(async () => []),
      chatThreadSave: vi.fn(async (req: { id: string; title: string }) => ({ id: req.id, title: req.title, updatedAt: new Date().toISOString(), home: true })),
      chatThreadGet: vi.fn(async () => homeThread()),
      chatAttach: vi.fn(),
      chatRelease: vi.fn(),
      setChatIncognito: vi.fn(),
      rememberOnClose: vi.fn(),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (...a: unknown[]) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("opens Home from the pinned row: posts appear once as one block, drain with the save, and start no turn", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(bean.chatThreadGet).toHaveBeenCalledWith("home", expect.any(String));
    expect(shownChat().textContent).toContain("While you were away · 2");
    expect(shownChat().querySelector(".bean-post strong")?.textContent).toBe("3");
    expect(shownChat().textContent).toContain('[card: run "deploy" — started]'); // inert text, not a card
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p1", "p2"]));
    expect(bean.chat).not.toHaveBeenCalled();
    expect(root.querySelector(".bean-chat-sidebar-home--active")).not.toBeNull();

    // A typed reply carries the posts as fenced, non-typed user context.
    await send("thanks, what about the third PR?");
    const req = bean.chat!.mock.calls[0]![0] as { history: Array<{ role: string; content: string; source?: string }>; source: string };
    expect(req.source).toBe("typed");
    expect(req.history.slice(0, 2)).toEqual([
      { role: "user", content: '[sprout "digest" posted]: <<<\n**3** PRs merged\n>>>', source: "loopback" },
      { role: "user", content: '[sprout "inbox" posted]: <<<\n[card: run "deploy" — started]\n>>>', source: "loopback" },
    ]);
    expect(root.querySelectorAll(".bean-post")).toHaveLength(2); // not appended twice
  });

  it("a failed save keeps the posts undrained for the next save", async () => {
    bean.chatThreadSave!.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await vi.waitFor(() => expect(bean.chatThreadSave).toHaveBeenCalledTimes(1));
    await send("hi");
    await vi.waitFor(() => expect(bean.chatThreadSave!.mock.calls.length).toBeGreaterThan(1));
    expect(savedPosts()).toEqual(["p1", "p2"]);
  });

  it("a hidden Home doesn't drain until it's shown", async () => {
    let resolve!: (t: unknown) => void;
    bean.chatThreadGet!.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    // A synced chat goes over it before the restore lands: Home is mounted but hidden.
    await click([...root.querySelectorAll(".bean-chat-sidebar-row")].find((r) => r.textContent?.includes("DM"))!.querySelector(".bean-chat-sidebar-open"));
    await act(async () => { resolve(homeThread()); });
    await flush();
    expect(root.querySelectorAll(".bean-post")).toHaveLength(0);
    expect(bean.chatThreadSave).not.toHaveBeenCalled();
    await click(homeRow());
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p1", "p2"]));

    // Hidden again, a post lands; shown again, Home asks for it.
    bean.chatThreadGet!.mockResolvedValueOnce(homeThread([...posts, { id: "p3", sprout: "digest", body: "late one", createdAt: now }]));
    await click([...root.querySelectorAll(".bean-chat-sidebar-row")].find((r) => r.textContent?.includes("DM"))!.querySelector(".bean-chat-sidebar-open"));
    await click(homeRow());
    expect(shownChat().textContent).toContain("late one");
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(3);
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p1", "p2", "p3"]));
  });

  it("at midnight an open Home stays, drops posts it never saved, and says where the next post goes", async () => {
    bean.chatThreadSave!.mockRejectedValue(new Error("disk full"));
    bean.chatThreadGet!.mockResolvedValueOnce({ ...homeThread(), home: { posts, until: new Date(Date.now() + 300).toISOString() } });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await flush();
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(0);
    expect(shownChat().textContent).toContain("A new day");
    expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull();
  });

  it("Home's Off the record opens a separate off-the-record chat; Home is never taken off the record", async () => {
    bean.chatThreadGet!.mockResolvedValueOnce(homeThread([]));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(shownChat().textContent).toContain("Sprouts set to Post to Home land here.");
    await click(shownChat().querySelector(".bean-chat-incognito"));
    expect(bean.setChatIncognito!.mock.calls).toEqual([[true, expect.any(String)]]);
    const homeMount = bean.chatThreadGet!.mock.calls[0]![1];
    expect(bean.setChatIncognito!.mock.calls[0]![1]).not.toBe(homeMount);
    expect(shownChat().querySelector(".bean-chat-incognito--on")).not.toBeNull();
    expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull();
  });
});
