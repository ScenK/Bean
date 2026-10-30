import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChatSession, type ChatSessionApi } from "./ChatSession.js";
import { ChatSidebar, SIDEBAR_INLINE_MIN, SIDEBAR_OPEN_KEY } from "./ChatSidebar.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import type { DesktopChatListing } from "@bean/core";

/** The chat window: the history sidebar plus the one chat it shows. A switch or New chat evicts the
 * shown ChatSession and mounts the pick with a new mount id — the BrowserWindow itself stays. The
 * preload's `on*` bridges can't unsubscribe, so they're registered here once and routed to whichever
 * session is mounted (`sessionRef`), along with the one-time pulled data. */
export function ChatWindow() {
  const sessionRef = useRef<ChatSessionApi | undefined>(undefined);
  const [session, setSession] = useState<{ mountId: string; restoreId?: string }>(() => ({ mountId: crypto.randomUUID() }));
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(undefined);
  // A per-turn memory receipt is tagged with the mount that asked. One for a chat switched away
  // mid-capture follows its thread: shown at once if that thread is back on screen, otherwise held
  // until it's restored. ponytail: held for this window's lifetime only — a receipt for a chat never
  // reopened before the window closes stays in Persona's memory list, not in the chat.
  const evictedRef = useRef(new Map<string, string>()); // evicted mount id → its thread id
  const lateRef = useRef(new Map<string, Array<Array<{ id: string; text: string }>>>()); // thread id → receipts
  const onMemoryUpdated = (saved: Array<{ id: string; text: string }>, from: string): void => {
    const shown = sessionRef.current;
    if (from === shown?.mountId) { shown.memoryUpdated(saved); return; }
    const thread = evictedRef.current.get(from);
    if (thread === undefined) return;
    if (shown?.threadId() === thread) { shown.memoryUpdated(saved); return; }
    lateRef.current.set(thread, [...(lateRef.current.get(thread) ?? []), saved]);
  };
  const takeLateReceipts = (thread: string): Array<Array<{ id: string; text: string }>> => {
    const late = lateRef.current.get(thread) ?? [];
    lateRef.current.delete(thread);
    return late;
  };
  // Settings invalidates this catalog, so an already-open card immediately stops offering a
  // CLI the user just disabled.
  const { clis, models: runModels } = useCliAvailability();
  // History sidebar: the list loads on mount and the active row follows each save ack. `busy` is the
  // shown chat's (a reply in flight, or its switch-away save).
  const [threads, setThreads] = useState<DesktopChatListing[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < SIDEBAR_INLINE_MIN);
  const [inlineOpen, setInlineOpen] = useState(() => localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const sidebarOpen = narrow ? overlayOpen : inlineOpen;
  const toggleSidebar = (): void => {
    if (narrow) { setOverlayOpen(!overlayOpen); return; }
    localStorage.setItem(SIDEBAR_OPEN_KEY, inlineOpen ? "0" : "1");
    setInlineOpen(!inlineOpen);
  };

  useEffect(() => {
    let was = window.innerWidth < SIDEBAR_INLINE_MIN;
    const onResize = (): void => {
      const now = window.innerWidth < SIDEBAR_INLINE_MIN;
      if (now === was) return;
      was = now;
      setNarrow(now);
      setOverlayOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Layout effect: listening as soon as the overlay renders (a passive effect can lag a frame).
  useLayoutEffect(() => {
    if (!narrow || !overlayOpen) return;
    // The composer's own Escape (slash menu) prevents default first.
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape" && !e.defaultPrevented) setOverlayOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, overlayOpen]);

  useEffect(() => {
    const setTheme = (theme: string): void => {
      document.documentElement.dataset.theme = theme;
    };
    const to = (): ChatSessionApi | undefined => sessionRef.current;
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.chatThreadList().then((t) => setThreads(t ?? []), () => {});
    // Pull any URL dropped before this window's renderer finished mounting — the push below
    // (onComponentDroppedUrl) can arrive first and gets silently dropped, same race
    // getPendingPlan fixes for the Plan window.
    window.bean.getPendingDroppedUrl().then((u) => { if (u) setDroppedUrl(u); });
    window.bean.onComponentDroppedUrl(setDroppedUrl);
    // A chat-target skill run confirmed in the Plan popup. Pull + push, same race fix as the dropped URL.
    window.bean.getPendingChatPrompt().then((p) => { if (p) to()?.runPrompt(p); });
    window.bean.onChatPrompt((p) => to()?.runPrompt(p));
    // A delegate run that was still going when Bean last quit — pull + push, same race fix.
    window.bean.getPendingInterruptedRunNotices().then((n) => { if (n?.length) to()?.notices(n); });
    window.bean.onInterruptedRunNotice((n) => to()?.notices(n));
    window.bean.onDelegateEvent((e) => to()?.delegateEvent(e));
    window.bean.onLiveEvent((e) => to()?.liveEvent(e));
    window.bean.onMemoryUpdated((saved, from) => onMemoryUpdated(saved, from));
    window.bean.onChatImageProgress((from) => to()?.imageProgress(from));
    window.bean.onReviewBeforeClose(() => {
      const s = to();
      if (s) s.reviewBeforeClose();
      else window.bean.allowChatClose();
    });
  }, []);

  // ChatPanel's prefill effect fires on a change to `droppedUrl` — flipping it back to
  // undefined right after handoff means a later drop of that exact same path is still a real
  // undefined→value transition (and so still prefills), not a no-op repeat of an unchanged prop.
  useEffect(() => {
    if (droppedUrl === undefined) return;
    const t = setTimeout(() => setDroppedUrl(undefined), 0);
    return () => clearTimeout(t);
  }, [droppedUrl]);

  const openThread = (target: string): void => {
    setOverlayOpen(false);
    sessionRef.current?.open(target);
  };
  const deleteThread = (id: string): void => {
    window.bean.chatThreadDelete(id).then(
      () => setThreads((prev) => prev.filter((t) => t.id !== id)),
      (err: unknown) => sessionRef.current?.error(`Couldn't delete that chat: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  return (
    <div class="bean-dashboard bean-chat-window">
      <button
        type="button"
        class={`bean-chat-sidebar-toggle${sidebarOpen ? " bean-chat-sidebar-toggle--open" : ""}`}
        aria-expanded={sidebarOpen}
        aria-label={sidebarOpen ? "Hide chat history" : "Show chat history"}
        title="Chat history"
        onClick={toggleSidebar}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
      </button>
      {sidebarOpen ? (
        <ChatSidebar
          threads={threads}
          activeId={activeId}
          busy={busy}
          overlay={narrow}
          onNew={() => openThread("new")}
          onOpen={openThread}
          onDelete={deleteThread}
        />
      ) : null}
      <ChatSession
        key={session.mountId}
        mountId={session.mountId}
        restoreId={session.restoreId}
        sessionRef={sessionRef}
        clis={clis}
        runModels={runModels}
        prefillUrl={droppedUrl}
        setThreads={setThreads}
        onActive={setActiveId}
        onBusy={setBusy}
        takeLateReceipts={takeLateReceipts}
        onSwitch={(target, thread) => {
          if (thread !== undefined) evictedRef.current.set(session.mountId, thread);
          setActiveId(target === "new" ? undefined : target);
          setBusy(false);
          setSession({ mountId: crypto.randomUUID(), ...(target === "new" ? {} : { restoreId: target }) });
        }}
      />
    </div>
  );
}
