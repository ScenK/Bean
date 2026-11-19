// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

// #516: the history sidebar switches chats inside the one window — evict (save, memory, release),
// then mount the pick with a new mount id. #517: a chat with work in flight stays mounted, hidden.
describe("ChatWindow switches chats in place", () => {
  const OTHER = "9f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const calls: string[] = [];
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const shownChat = (): Element => root.querySelector(".bean-chat:not([hidden])")!;
  const send = async (text: string): Promise<void> => {
    const ta = shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  const clickEl = async (el: Element | null | undefined): Promise<void> => {
    if (!el) throw new Error("no element");
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };
  const rowOf = (title: string): Element | undefined => [...root.querySelectorAll(".bean-chat-sidebar-row")].find((b) => b.textContent?.includes(title));
  const otherRow = (): Element | undefined => rowOf("other chat")?.querySelector(".bean-chat-sidebar-open") ?? undefined;
  const openRow = (title: string): Element | undefined => rowOf(title)?.querySelector(".bean-chat-sidebar-open") ?? undefined;
  const button = (label: string, within: Element = root): Element | undefined =>
    [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const delegateReply = { reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } };
  const mounts = (ch: string): string[] => bean[ch]!.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    calls.length = 0;
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "first reply", model: "m" })),
      chatThreadList: vi.fn(async () => [{ id: OTHER, title: "other chat", updatedAt: new Date().toISOString(), agents: [], starred: false }]),
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

  it("a pushed prompt (Continue in chat) starts a new chat instead of landing in the one on screen", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce({ prompt: "pick up the note", label: "Continue: n" }); listeners.onChatPrompt!(undefined); });
    await flush();
    const second = mounts("chatAttach")[1]!;
    expect(second).not.toBe(first);
    expect(bean.chat!.mock.calls.map((c) => [(c[0] as { message: string }).message, c[1]])).toEqual([["hello there", first], ["pick up the note", second]]);
    expect(shownChat().textContent).toContain("Continue: n");
    expect(shownChat().textContent).not.toContain("hello there");

    // A later New chat is a plain empty one — the prompt was used up.
    await clickEl(root.querySelector(".bean-chat-sidebar-new"));
    expect(bean.chatAttach).toHaveBeenCalledTimes(3);
    expect(bean.chat).toHaveBeenCalledTimes(2);
    // Leaving saved it under a thread of its own, so it's in history.
    expect(bean.chatThreadSave!.mock.calls.some((c) => c[1] === second && (c[0] as { title: string }).title.includes("Continue: n"))).toBe(true);
  });

  it("a push runs only the stored copy it claims, so an already-claimed prompt never replays", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    bean.getPendingChatPrompt = vi.fn(async () => undefined);
    await act(async () => { listeners.onChatPrompt!({ prompt: "already run", label: "x" }); });
    await flush();
    expect(bean.getPendingChatPrompt).toHaveBeenCalledTimes(1);
    expect(bean.chat).not.toHaveBeenCalled();
  });

  it("Add to current chat (here) lands in the chat on screen, used or not", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce({ prompt: "pick up the note", label: "Continue: n", here: true }); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(mounts("chatAttach")).toEqual([first]);
    expect(bean.chat!.mock.calls.map((c) => c[1])).toEqual([first, first]);
    expect(shownChat().textContent).toContain("hello there");
  });

  it("Add to current chat while Bean is answering is refused with a note, not queued", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    let answer: (v: unknown) => void = () => {};
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const ta = shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = "hello there";
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce({ prompt: "pick up the note", label: "Continue: n", here: true }); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(shownChat().textContent).toContain('send "Continue: n" again');
    await act(async () => { answer({ reply: "first reply", model: "m" }); });
    await flush();
    expect(bean.chat).toHaveBeenCalledTimes(1);
  });

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
    await clickEl(openRow("hello there"));
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

  it("a delegate keeps running in a chat switched away from: its summary lands there, the row spins then dots", async () => {
    bean.delegateStart = vi.fn(async () => "task1");
    bean.chat!.mockResolvedValueOnce(delegateReply);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    await clickEl(button("Delegate", shownChat()));
    expect(bean.delegateStart).toHaveBeenCalledWith(expect.anything(), first);

    await clickEl(otherRow());
    expect(calls).toEqual([`attach ${first}`, `attach ${mounts("chatAttach")[1]}`]); // A neither remembered nor released
    expect(shownChat().textContent).toContain("restored reply");
    expect(rowOf("hello there")!.querySelector(".bean-chat-sidebar-spinner")).not.toBeNull();

    // Tagged for A while B is shown: the loopback runs in A at once.
    bean.chat!.mockResolvedValueOnce({ reply: "the audit found nothing", model: "m" });
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "done", result: "clean", mountId: first }); });
    await flush();
    expect(bean.chat!.mock.calls.at(-1)).toEqual([expect.objectContaining({ source: "loopback" }), first]);
    expect(shownChat().textContent).not.toContain("the audit found nothing");
    expect(rowOf("hello there")!.querySelector(".bean-chat-sidebar-spinner")).toBeNull();
    expect(rowOf("hello there")!.querySelector(".bean-chat-sidebar-dot")).not.toBeNull();

    // Back to A: shown as it is (no restore), dot cleared; B was idle, so it was evicted.
    await clickEl(openRow("hello there"));
    expect(bean.chatThreadGet).toHaveBeenCalledTimes(1);
    expect(shownChat().textContent).toContain("the audit found nothing");
    expect(root.querySelector(".bean-chat-sidebar-dot")).toBeNull();
    expect(bean.chatRelease!.mock.calls.map((c) => c[0])).toEqual([mounts("chatAttach")[1]]);
  });

  it("a sprout card answers at admission; the chat stays mounted and the result turn lands there, after a busy turn (#921)", async () => {
    const plan = { routine: "digest", action: "run", actionLine: "Runs its steps once now", resultsTo: "a note", paused: false, queuesNew: false };
    bean.chatSproutRun = vi.fn(async () => ({ jobId: "job1" }));
    bean.chat!.mockResolvedValueOnce({ reply: "want me to?", model: "m", sproutRun: plan });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("run digest");
    await clickEl(button("Run", shownChat()));
    const [, thread, mount] = bean.chatSproutRun.mock.calls[0]!;
    expect(mount).toBe(first);
    expect(thread).toMatch(/^[0-9a-f-]{36}$/);
    expect(button("Running…", shownChat())).toBeDefined(); // answered; still running, no Stop
    // The run's admission push (#922, for a remote shell's lost reply) settles nothing.
    await act(async () => { listeners.onSproutEvent!({ mountId: first, jobId: "job1", name: "digest" }); });
    await flush();
    expect(button("Running…", shownChat())).toBeDefined();

    await clickEl(otherRow());
    expect(bean.chatRelease).not.toHaveBeenCalled(); // a running sprout is work: kept mounted
    expect(rowOf("run digest")!.querySelector(".bean-chat-sidebar-spinner")).not.toBeNull();

    // Back in A, a Bean turn is running when the result arrives: it runs after that turn.
    await clickEl(openRow("run digest"));
    let reply: (r: unknown) => void = () => {};
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { reply = r; }));
    await send("meanwhile");
    await act(async () => { listeners.onSproutEvent!({ mountId: first, jobId: "job1", status: "ok", text: "digest finished ✓" }); });
    await flush();
    expect(bean.chat!.mock.calls.at(-1)![0].message).toBe("meanwhile");
    bean.chat!.mockResolvedValueOnce({ reply: "the digest went out", model: "m" });
    await act(async () => { reply({ reply: "sure", model: "m" }); });
    await flush();
    expect(bean.chat!.mock.calls.at(-1)).toEqual([expect.objectContaining({ source: "loopback", message: expect.stringContaining('[sprout result for "digest"]: digest finished ✓') }), first]);
    expect(shownChat().textContent).toContain("the digest went out");
    expect(shownChat().textContent).toContain("Finished");
    // A repeated push loops nothing back again.
    await act(async () => { listeners.onSproutEvent!({ mountId: first, jobId: "job1", status: "ok", text: "digest finished ✓" }); });
    await flush();
    expect(bean.chat!.mock.calls.filter((c) => c[0].source === "loopback")).toHaveLength(1);
  });

  it("a restored chat's running sprout card shows how the run really ended and loops it back (#921)", async () => {
    const plan = { routine: "digest", action: "run", actionLine: "Runs its steps once now", resultsTo: "a note", paused: false, queuesNew: false };
    bean.chatThreadGet!.mockResolvedValueOnce({
      id: OTHER, title: "other chat", noteSlug: null,
      items: [{ kind: "sprout", id: "item-1", plan, state: "running", jobId: "job1" }],
      sprouts: [{ jobId: "job1", status: "interrupted", text: "digest was interrupted ✗" }],
    });
    bean.chat!.mockResolvedValueOnce({ reply: "it was cut off by a restart", model: "m" });
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await clickEl(otherRow());
    await flush();
    expect(shownChat().textContent).toContain("Interrupted — Bean restarted before it finished");
    expect(bean.chat!.mock.calls.at(-1)![0]).toMatchObject({ source: "loopback", message: expect.stringContaining("digest was interrupted ✗") });
    expect(shownChat().textContent).toContain("it was cut off by a restart");
  });

  it("a hidden chat that went idle is evicted at the next switch", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    let reply: (r: unknown) => void = () => {};
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { reply = r; }));
    await send("and then");
    await clickEl(otherRow()); // a reply in flight: kept
    expect(bean.chatRelease).not.toHaveBeenCalled();
    await act(async () => { reply({ reply: "late answer", model: "m" }); });
    await flush();
    expect(rowOf("hello there")!.querySelector(".bean-chat-sidebar-dot")).not.toBeNull();
    await clickEl(root.querySelector(".bean-chat-sidebar-new"));
    expect(calls).toContain(`remember ${first}`);
    expect(calls.indexOf(`remember ${first}`)).toBeLessThan(calls.indexOf(`release ${first}`));
    expect(root.querySelectorAll(".bean-chat")).toHaveLength(1);
    expect(rowOf("hello there")!.querySelector(".bean-chat-sidebar-dot")).not.toBeNull(); // unread outlives eviction
  });

  it("leaving an off-the-record chat with a running task asks first; Stop & switch stops it and discards the chat", async () => {
    bean.delegateStart = vi.fn(async () => "task1");
    bean.delegateCancel = vi.fn();
    bean.chat!.mockResolvedValueOnce(delegateReply);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    await clickEl(button("Delegate", shownChat()));
    await clickEl(button("Off the record", shownChat()));
    await clickEl(otherRow());
    expect(root.textContent).toContain("Leaving discards this chat and stops its task.");
    await clickEl(button("Keep working"));
    expect(root.querySelector(".bean-memory-review")).toBeNull();
    expect(bean.chatAttach).toHaveBeenCalledTimes(1);

    await clickEl(otherRow());
    await clickEl(button("Stop & switch"));
    expect(bean.delegateCancel).toHaveBeenCalledWith("task1");
    expect(bean.rememberOnClose).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ incognito: true, mountId: first }));
    expect(calls.slice(-3)).toEqual([`remember ${first}`, `release ${first}`, `attach ${mounts("chatAttach")[1]}`]);
    expect(root.querySelectorAll(".bean-chat")).toHaveLength(1);
  });

  it("an open agent session marks its row (spinner only mid-turn); an avatar bubble brings the hidden chat back", async () => {
    bean.liveStart = vi.fn(async () => ({ sessionId: "s1", handedOver: 0 }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const first = mounts("chatAttach")[0]!;
    await send("hello there");
    await send("/claude fix X");
    const row = (): Element => rowOf("hello there")!;
    expect(row().classList.contains("bean-chat-sidebar-row--live")).toBe(true);
    expect(row().querySelector(".bean-chat-sidebar-spinner")).not.toBeNull(); // the opening turn runs
    await act(async () => { listeners.onLiveEvent!({ sessionId: "s1", agent: "claude", mountId: first, seq: 1, type: "turn", result: "done X" }); });
    await flush();
    expect(row().querySelector(".bean-chat-sidebar-spinner")).toBeNull(); // waiting for you
    expect(row().classList.contains("bean-chat-sidebar-row--live")).toBe(true);
    // A queued follow-up's turn starts on its own: its output spins the row again.
    await act(async () => { listeners.onLiveEvent!({ sessionId: "s1", agent: "claude", mountId: first, seq: 2, type: "output", line: "Edit y.ts" }); });
    await flush();
    expect(row().querySelector(".bean-chat-sidebar-spinner")).not.toBeNull();
    await act(async () => { listeners.onLiveEvent!({ sessionId: "s1", agent: "claude", mountId: first, seq: 3, type: "turn", result: "done Y" }); });
    await flush();

    await clickEl(otherRow());
    expect(shownChat().textContent).toContain("restored reply");
    expect(row().classList.contains("bean-chat-sidebar-row--live")).toBe(true); // hidden, still open
    await act(async () => { listeners.onShowChatMount!(first); });
    await flush();
    expect(shownChat().textContent).toContain("done X");
    expect(root.querySelector(".bean-chat-sidebar-row--active")!.textContent).toContain("hello there");

    // Session over, chat left (idle, so evicted): a lingering bubble still reopens its thread.
    await act(async () => { listeners.onLiveEvent!({ sessionId: "s1", agent: "claude", mountId: first, seq: 4, type: "ended", reason: "stopped" }); });
    await flush();
    expect(row().classList.contains("bean-chat-sidebar-row--live")).toBe(false);
    await clickEl(otherRow());
    expect(bean.chatRelease).toHaveBeenCalledWith(first);
    // By mount, not title: every test here sends "hello there".
    const thread = (bean.chatThreadSave!.mock.calls.find((c) => c[1] === first)![0] as { id: string }).id;
    bean.chatThreadGet!.mockResolvedValueOnce({ id: thread, title: "hello there", items: [{ kind: "reply", id: "item-1", text: "back again" }], noteSlug: null });
    await act(async () => { listeners.onShowChatMount!(first); });
    await flush();
    expect(bean.chatThreadGet).toHaveBeenLastCalledWith(thread, expect.any(String));
    expect(shownChat().textContent).toContain("back again");
  });

  it("closing the window counts tasks across chats and stops them all", async () => {
    let n = 0;
    bean.delegateStart = vi.fn(async () => `task${++n}`);
    bean.delegateCancel = vi.fn();
    bean.chat!.mockResolvedValueOnce(delegateReply);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("hello there");
    await clickEl(button("Delegate", shownChat()));
    await clickEl(otherRow());
    bean.chat!.mockResolvedValueOnce(delegateReply);
    await send("audit this one too");
    await clickEl(button("Delegate", shownChat()));

    await act(async () => { listeners.onReviewBeforeClose!(undefined); });
    await flush();
    expect(root.textContent).toContain("Closing stops 2 tasks in 2 chats.");
    expect(bean.allowChatClose).not.toHaveBeenCalled();
    await clickEl(button("Stop & close"));
    expect(bean.delegateCancel!.mock.calls.map((c) => c[0]).sort()).toEqual(["task1", "task2"]);
    expect(bean.rememberOnClose).toHaveBeenCalledTimes(2);
    expect(bean.allowChatClose).toHaveBeenCalledTimes(1);
  });
});
