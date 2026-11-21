// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

// #960: Home — the pinned row opens it, its pending posts are appended once (no model turn)
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
  const homeThread = (p = posts) => ({ id: HOME, title: "Home", items: [], noteSlug: null, home: { posts: p } });

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
      homePending: vi.fn(async () => 0),
      chatMainSince: vi.fn(async () => ({ rows: [], cursor: 0, trimmed: false })),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (...a: unknown[]) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("a post in a batch that lands 3 h+ after everything before it gets its divider inside the fold (#977)", async () => {
    const ago = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
    bean.chatThreadGet!.mockResolvedValue({
      ...homeThread([{ id: "p1", sprout: "digest", body: "early", createdAt: ago(9) }, { id: "p2", sprout: "inbox", body: "late", createdAt: ago(0) }]),
      items: [{ kind: "user", id: "u", text: "morning", at: ago(10) }],
    });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(shownChat().querySelectorAll(".bean-chat-divider")).toHaveLength(1);
    expect(shownChat().querySelector(".bean-post-batch .bean-chat-divider + .bean-chat-row")?.textContent).toContain("late");
  });

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

  it("on the main log (#997): sends keyed deltas instead of history, never re-sends an acked turn, and drops a stale Discord pointer", async () => {
    bean.chatThreadGet!.mockResolvedValue({
      ...homeThread([]), home: { posts: [], log: true },
      items: [{ kind: "user", id: "old", text: "before" }, { kind: "continued", id: "c", surface: "discord", conversationId: "t", title: "moved" }],
    });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await send("first");
    const first = bean.chat!.mock.calls[0]![0] as { history: unknown[]; delta?: unknown[]; summary?: string; turnId: string };
    expect(first.history).toEqual([]);
    expect(first.delta).toEqual([]); // restored turns were flushed by the save that kept them
    expect(first.turnId).toMatch(/^item-[0-9a-f]{8}-\d+$/); // unique across renderer loads
    await send("second");
    const second = bean.chat!.mock.calls[1]![0] as { delta?: unknown[] };
    expect(second.delta).toEqual([]); // the first turn and its reply were acked by the host
    expect(shownChat().textContent).not.toContain("Already continued");
  });

  it("#1000: shows the owner's DM exchanges labelled, once each, never in the delta or close-time memory", async () => {
    const dm = (seq: number, role: string, text: string, via = "discord") => ({ seq, via, row: { role, text } });
    const cutover = "Your Discord and Teams DMs are now part of this conversation — Bean remembers them.";
    bean.chatThreadGet!.mockResolvedValue({ ...homeThread([]), home: { posts: [], log: true, cursor: 0 } });
    bean.chatMainSince!
      .mockResolvedValueOnce({ rows: [dm(2, "user", "from my phone"), dm(3, "bean", "got it")], cursor: 3, trimmed: false, cutover })
      .mockResolvedValue({ rows: [dm(3, "bean", "got it"), dm(5, "status", "Card: note — saved", "teams")], cursor: 6, trimmed: false });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    const chat = shownChat();
    expect(bean.chatMainSince).toHaveBeenCalledWith(0, expect.any(String));
    expect(chat.querySelector(".bean-dm .bean-bubble--user")?.textContent).toContain("from my phone");
    expect(chat.querySelector(".bean-dm-via")?.textContent).toBe("via Discord");
    expect(chat.textContent).toContain("got it");
    expect(chat.textContent).toContain(cutover);
    await vi.waitFor(() => expect(bean.chatThreadSave!.mock.calls.at(-1)?.[0]).toMatchObject({ mainCursor: 3 }));

    // A bot's ping pulls again: the seen row isn't doubled, the new one shows labelled.
    await act(async () => { listeners.onChatMainChanged!(bean.chatAttach!.mock.calls.at(-1)![0]); });
    await flush();
    expect(bean.chatMainSince).toHaveBeenLastCalledWith(3, expect.any(String));
    expect(chat.textContent?.match(/got it/g)).toHaveLength(1);
    expect(chat.textContent).toContain("Card: note — saved · via Teams");
    expect(chat.textContent?.split(cutover)).toHaveLength(2); // once

    // A desktop turn: the pulled rows never ride in the delta, and the turn's end pulls.
    const calls = bean.chatMainSince!.mock.calls.length;
    await send("thanks");
    const req = bean.chat!.mock.calls[0]![0] as { delta?: Array<{ content: string }> };
    expect(req.delta?.map((t) => t.content).join("\n") ?? "").not.toMatch(/from my phone|got it|Card: note/);
    expect(bean.chatMainSince!.mock.calls.length).toBeGreaterThan(calls);
  });

  it("#1000: a remote core reattaching re-opens Home on it (a restarted core lost the pin), then pulls", async () => {
    bean.chatThreadGet!.mockResolvedValue({ ...homeThread([]), home: { posts: [], log: true, cursor: 0 } });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    const gets = bean.chatThreadGet!.mock.calls.length;
    const pulls = bean.chatMainSince!.mock.calls.length;
    try {
      await act(async () => { listeners.onCoreStatus!({ kind: "remote", host: "me@box", state: "attached" }); });
      await flush();
      expect(bean.chatThreadGet!.mock.calls.slice(gets).map((c) => c[0])).toEqual(["home"]);
      expect(bean.chatMainSince!.mock.calls.length).toBeGreaterThan(pulls);
      // The re-open came first: the pull rides on the restored pin.
      const getAt = bean.chatThreadGet!.mock.invocationCallOrder.at(-1)!;
      expect(bean.chatMainSince!.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(getAt);
    } finally {
      await act(async () => { listeners.onCoreStatus!({ kind: "local" }); });
    }
  });

  it("#1000: a chat not on the main log never pulls DM rows", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(bean.chatMainSince).not.toHaveBeenCalled();
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

  it("a Home restored while hidden appends main's list when shown, so a post that expired meanwhile stays out", async () => {
    let resolve!: (t: unknown) => void;
    bean.chatThreadGet!.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    bean.chatThreadGet!.mockResolvedValueOnce(homeThread([posts[1]!])); // p1 expired while hidden
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await click([...root.querySelectorAll(".bean-chat-sidebar-row")].find((r) => r.textContent?.includes("DM"))!.querySelector(".bean-chat-sidebar-open"));
    await act(async () => { resolve(homeThread()); });
    await flush();
    await click(homeRow());
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(1);
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p2"]));
  });

  it("#961: a post landing in a shown Home shows the jump-down pill; its click appends, drains and clears it", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p1", "p2"]));
    expect(root.querySelector(".bean-chat-sidebar-dot")).toBeNull();
    expect(shownChat().querySelector(".bean-jump-down")).toBeNull();

    // A post lands: the count goes up, the dot and the pill show; nothing is pushed into the chat.
    const p3 = { id: "p3", sprout: "digest", body: "late one", createdAt: now };
    await act(async () => { listeners.onTaskStatus!([{ id: "home:posts", kind: "home", count: 1 }]); });
    await flush();
    expect(root.querySelector(".bean-chat-sidebar-home .bean-chat-sidebar-dot")).not.toBeNull();
    const pill = shownChat().querySelector(".bean-jump-down");
    expect(pill?.getAttribute("aria-label")).toBe("New posts");
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);

    // A failed load leaves the pill for the next click.
    bean.chatThreadGet!.mockRejectedValueOnce(new Error("Not connected"));
    await click(pill);
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);
    expect(shownChat().querySelector(".bean-jump-down")).not.toBeNull();

    bean.chatThreadGet!.mockResolvedValueOnce(homeThread([p3]));
    await click(shownChat().querySelector(".bean-jump-down"));
    expect(shownChat().textContent).toContain("late one");
    await vi.waitFor(() => expect(savedPosts()).toEqual(["p1", "p2", "p3"]));
    // The drain recounts to zero: dot and pill go.
    await act(async () => { listeners.onTaskStatus!([]); });
    await flush();
    expect(root.querySelector(".bean-chat-sidebar-dot")).toBeNull();
    expect(shownChat().querySelector(".bean-jump-down")).toBeNull();
  });

  it("#961: picking Home again (bubble, banner) catches up; a failed save is retried there, not lost", async () => {
    bean.chatThreadSave!.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await vi.waitFor(() => expect(bean.chatThreadSave).toHaveBeenCalledTimes(1));
    const gets = bean.chatThreadGet!.mock.calls.length;
    await act(async () => { listeners.onChatShowHome!(); });
    await flush();
    expect(bean.chatThreadGet!.mock.calls.length).toBe(gets + 1);
    // Nothing new to append, but the posts never drained: the open saves them again.
    await vi.waitFor(() => expect(bean.chatThreadSave).toHaveBeenCalledTimes(2));
    expect(savedPosts()).toEqual(["p1", "p2"]);
  });

  it("#961: a failed Home restore isn't Home — the Home row retries it", async () => {
    bean.chatThreadGet!.mockRejectedValueOnce(new Error("Not connected to me@box — reconnecting."));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    await vi.waitFor(() => expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull());
    await click(homeRow());
    expect(bean.chatThreadGet).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".bean-chat-sidebar-home--active")).not.toBeNull();
    expect(shownChat().querySelectorAll(".bean-post")).toHaveLength(2);
  });

  it("#961: the Home row's dot follows the pending count, also beside another chat", async () => {
    bean.homePending!.mockResolvedValueOnce(2);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    expect(root.querySelector(".bean-chat-sidebar-home .bean-chat-sidebar-dot")?.getAttribute("aria-label")).toBe("New posts");
    await act(async () => { listeners.onTaskStatus!([]); });
    await flush();
    expect(root.querySelector(".bean-chat-sidebar-home .bean-chat-sidebar-dot")).toBeNull();
  });

  it("Home's Off the record opens a separate off-the-record chat; Home is never taken off the record", async () => {
    bean.chatThreadGet!.mockResolvedValueOnce(homeThread([]));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(shownChat().textContent).toContain("Sprouts set to post to your chat with Bean land here.");
    await click(shownChat().querySelector(".bean-chat-incognito"));
    expect(bean.setChatIncognito!.mock.calls).toEqual([[true, expect.any(String)]]);
    const homeMount = bean.chatThreadGet!.mock.calls[0]![1];
    expect(bean.setChatIncognito!.mock.calls[0]![1]).not.toBe(homeMount);
    expect(shownChat().querySelector(".bean-chat-incognito--on")).not.toBeNull();
    expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull();
  });

  // #1001: the main conversation is the avatar's default, never where a pushed task or a drop lands.
  it("on the main conversation, a pushed prompt (even Add to current chat) and a dropped URL open a task chat", async () => {
    bean.chatThreadGet!.mockResolvedValue(homeThread([]));
    bean.getPersona = vi.fn(async () => ({ name: "Pip", tags: ["Warm"] }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(homeRow());
    expect(root.querySelector(".bean-chat-sidebar-home-title")?.textContent).toBe("🏠 Pip");
    await vi.waitFor(() => expect(shownChat().textContent).toContain("Sprouts set to post to your chat with Pip land here."));
    const mainMount = bean.chatAttach!.mock.calls.at(-1)![0];
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce({ prompt: "pick up the note", label: "Continue: n", here: true }); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(bean.chat!.mock.calls.map((c) => c[1])).toHaveLength(1);
    expect(bean.chat!.mock.calls[0]![1]).not.toBe(mainMount);
    expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull();

    await click(homeRow());
    expect(root.querySelector(".bean-chat-sidebar-home--active")).not.toBeNull();
    await act(async () => { listeners.onComponentDroppedUrl!("https://example.com/a"); });
    await flush();
    expect(root.querySelector(".bean-chat-sidebar-home--active")).toBeNull();
    expect((shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement).value).toContain("https://example.com/a");
  });
});
