import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChatSession, type ChatSessionApi, type ChatTasks } from "./ChatSession.js";
import { ChatSidebar, SIDEBAR_INLINE_MIN, SIDEBAR_OPEN_KEY } from "./ChatSidebar.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { DesktopChatListing } from "@bean/core";

/** The window-close card for the chats with running tasks (one entry per chat). */
export function closeCard(busy: ChatTasks[]): { title: string; stop: string } {
  const count = busy.reduce((n, t) => n + t.delegates + (t.live ? 1 : 0), 0);
  const only = busy.length === 1 ? busy[0] : undefined;
  const name = only?.live ? AGENT_NAMES[only.live] : undefined;
  if (only && name && only.delegates === 0) return { title: `${name} is still running — closing ends the session.`, stop: `End ${name} session & close` };
  if (only && name && only.delegates === 1) return { title: `A delegated task and a ${name} session are still running — closing stops both.`, stop: "Stop & close" };
  if (count === 1) return { title: "A delegated task is still running — closing will stop it.", stop: "Stop & close" };
  return { title: `Closing stops ${count} tasks in ${busy.length} chat${busy.length === 1 ? "" : "s"}.`, stop: "Stop & close" };
}

/** The chat window: the history sidebar plus the chat it shows. A switch or New chat shows the pick
 * — the BrowserWindow itself stays. The chat left behind is evicted when idle, otherwise it stays
 * mounted, hidden, until it's idle at a later switch (#517); a pick already mounted is just shown.
 * The preload's `on*` bridges can't unsubscribe, so they're registered here once and routed by the
 * event's mount id (or to the shown chat), along with the one-time pulled data. */
export function ChatWindow() {
  const sessions = useRef(new Map<string, ChatSessionApi>()).current;
  const [mounts, setMounts] = useState<Array<{ mountId: string; restoreId?: string }>>(() => [{ mountId: crypto.randomUUID() }]);
  const [shown, setShownState] = useState(() => mounts[0]!.mountId);
  const shownRef = useRef(shown);
  const setShown = (id: string): void => { shownRef.current = id; setShownState(id); };
  const shownApi = (): ChatSessionApi | undefined => sessions.get(shownRef.current);
  // Sidebar state, keyed by thread so it outlives eviction: work in flight per mount (its thread),
  // and threads with a reply or live turn that landed while hidden.
  const [working, setWorking] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [closing, setClosing] = useState<{ title: string; stop: string } | null>(null);
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(undefined);
  // A per-turn memory receipt is tagged with the mount that asked. One for a chat switched away
  // mid-capture follows its thread: shown at once if that thread is back on screen, otherwise held
  // until it's restored. ponytail: held for this window's lifetime only — a receipt for a chat never
  // reopened before the window closes stays in Persona's memory list, not in the chat.
  const evictedRef = useRef(new Map<string, string>()); // evicted mount id → its thread id
  const lateRef = useRef(new Map<string, Array<Array<{ id: string; text: string }>>>()); // thread id → receipts
  const onMemoryUpdated = (saved: Array<{ id: string; text: string }>, from: string): void => {
    const mounted = sessions.get(from);
    if (mounted) { mounted.memoryUpdated(saved); return; }
    const thread = evictedRef.current.get(from);
    if (thread === undefined) return;
    const holder = [...sessions.values()].find((s) => s.threadId() === thread);
    if (holder) { holder.memoryUpdated(saved); return; }
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
  // shown chat's switch-away save.
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
    const to = shownApi;
    // Tagged with the chat that started it — hidden or shown; untagged = the shown one.
    const route = (mountId: string | undefined): ChatSessionApi | undefined => (mountId === undefined ? shownApi() : sessions.get(mountId));
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
    window.bean.onDelegateEvent((e) => route(e.mountId)?.delegateEvent(e));
    window.bean.onLiveEvent((e) => route(e.mountId)?.liveEvent(e));
    window.bean.onMemoryUpdated((saved, from) => onMemoryUpdated(saved, from));
    // Progress for a chat that's gone is dropped, never shown in another one.
    window.bean.onChatImageProgress((from) => sessions.get(from)?.imageProgress());
    window.bean.onReviewBeforeClose(reviewBeforeClose);
  }, []);

  // ChatPanel's prefill effect fires on a change to `droppedUrl` — flipping it back to
  // undefined right after handoff means a later drop of that exact same path is still a real
  // undefined→value transition (and so still prefills), not a no-op repeat of an unchanged prop.
  useEffect(() => {
    if (droppedUrl === undefined) return;
    const t = setTimeout(() => setDroppedUrl(undefined), 0);
    return () => clearTimeout(t);
  }, [droppedUrl]);

  // Window close: one card for every chat's running tasks; closing writes and remembers each chat.
  const closeAll = async (): Promise<void> => {
    setClosing(null);
    await Promise.all([...sessions.values()].map((s) => s.closeOut()));
    window.bean.allowChatClose();
  };
  const reviewBeforeClose = (): void => {
    const busy = [...sessions.values()].map((s) => s.tasks()).filter((t) => t.delegates > 0 || t.live);
    if (busy.length === 0) void closeAll();
    else setClosing(closeCard(busy));
  };
  const stopAndClose = async (): Promise<void> => {
    await Promise.all([...sessions.values()].map((s) => s.stopTasks()));
    await closeAll();
  };

  const dropMount = (mountId: string): void => {
    const thread = sessions.get(mountId)?.threadId();
    if (thread !== undefined) evictedRef.current.set(mountId, thread);
    setMounts((prev) => prev.filter((m) => m.mountId !== mountId));
    setWorking(({ [mountId]: _, ...rest }) => rest);
  };
  // The shown chat left for `target` (kept mounted, or evicted). A pick another mounted chat already
  // holds is shown as is; otherwise it mounts fresh (restoring the thread). Then every other hidden
  // chat that's idle now evicts itself.
  const switchTo = (from: string, target: string, keep: boolean): void => {
    if (!keep) dropMount(from);
    const held = target === "new" ? undefined : [...sessions.values()].find((s) => s.mountId !== from && s.threadId() === target);
    const next = held?.mountId ?? crypto.randomUUID();
    if (!held) setMounts((prev) => [...prev, { mountId: next, ...(target === "new" ? {} : { restoreId: target }) }]);
    setShown(next);
    setActiveId(target === "new" ? undefined : target);
    setBusy(false);
    setUnread((prev) => { const u = new Set(prev); u.delete(target); return u; });
    for (const s of sessions.values()) if (s.mountId !== next && s.mountId !== from) s.sweep();
  };

  const openThread = (target: string): void => {
    setOverlayOpen(false);
    shownApi()?.open(target);
  };
  const deleteThread = (id: string): void => {
    window.bean.chatThreadDelete(id).then(
      () => setThreads((prev) => prev.filter((t) => t.id !== id)),
      (err: unknown) => shownApi()?.error(`Couldn't delete that chat: ${err instanceof Error ? err.message : String(err)}`),
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
          working={new Set(Object.values(working))}
          unread={unread}
          overlay={narrow}
          onNew={() => openThread("new")}
          onOpen={openThread}
          onDelete={deleteThread}
        />
      ) : null}
      {mounts.map(({ mountId, restoreId }) => (
        <ChatSession
          key={mountId}
          mountId={mountId}
          restoreId={restoreId}
          sessions={sessions}
          hidden={mountId !== shown}
          clis={clis}
          runModels={runModels}
          prefillUrl={mountId === shown ? droppedUrl : undefined}
          setThreads={setThreads}
          onActive={(id) => { if (mountId === shownRef.current) setActiveId(id); }}
          onBusy={(b) => { if (mountId === shownRef.current) setBusy(b); }}
          onWorking={(thread) => setWorking(({ [mountId]: _, ...rest }) => (thread === undefined ? rest : { ...rest, [mountId]: thread }))}
          onUnread={() => {
            const thread = sessions.get(mountId)?.threadId();
            if (thread !== undefined && mountId !== shownRef.current) setUnread((prev) => new Set(prev).add(thread));
          }}
          takeLateReceipts={takeLateReceipts}
          onSwitch={(target, keep) => switchTo(mountId, target, keep)}
          onEvicted={() => dropMount(mountId)}
        />
      ))}
      {closing ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">{closing.title}</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => setClosing(null)}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void stopAndClose()}>{closing.stop}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
