import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChatSession, commandList, type ChatSessionApi, type ChatTasks } from "./ChatSession.js";
import { ChatSidebar, cleanGroupName, SIDEBAR_INLINE_MIN, SIDEBAR_OPEN_KEY } from "./ChatSidebar.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import { ListFoldToggle } from "../../shared/ListFold.js";
import { SyncedChat, syncedKey } from "./SyncedChat.js";
import { isTerminalToggle, tabShortcut } from "./TerminalPane.js";
import type { DesktopChatListing } from "@bean/core";
import type { ChatDrop } from "../../../channels.js";
import type { SyncedChatListing } from "../../../synced-chats.js";
import type { CoreStatus } from "../../../channels.js";
import { useCoreStatus } from "../../shared/core-status.js";

/** A remote core's bar over the chat (#811): reconnecting (the composer is read-only meanwhile) or taken
 * over by another machine. Nothing for a local core or an attached remote one; a version mismatch is
 * the blocking card instead. */
export function CoreBar({ status }: { status: CoreStatus }) {
  if (status.kind !== "remote" || status.state === "attached" || status.state === "mismatch") return null;
  if (status.state === "revoked") {
    return (
      <div class="bean-core-bar" role="status">
        <span class="bean-core-bar-text">Attached from another machine</span>
        <button type="button" class="bean-btn bean-core-bar-btn" onClick={() => window.bean.coreTakeBack()}>Take back</button>
      </div>
    );
  }
  return (
    <div class="bean-core-bar" role="status">
      <span class="bean-core-bar-text">
        {status.state === "connecting" ? "Connecting" : "Reconnecting"} to {status.host}…
        {status.message ? <span class="bean-core-bar-detail"> {status.message}</span> : null}
        {status.command ? <span class="bean-core-bar-detail"> Run once in Terminal: <code>{status.command}</code></span> : null}
      </span>
    </div>
  );
}

/** The window-close card for the chats with running tasks (one entry per chat). */
export function closeCard(busy: ChatTasks[]): { title: string; stop: string } {
  const count = busy.reduce((n, t) => n + t.delegates + (t.live ? 1 : 0) + (t.terminal?.length ?? 0), 0);
  const only = busy.length === 1 ? busy[0] : undefined;
  const cmds = only?.terminal ?? [];
  if (cmds.length === 1 && count === 1) return { title: `${cmds[0]} is still running in the terminal — closing stops it.`, stop: "Stop & close" };
  if (cmds.length > 1 && count === cmds.length) return { title: `${commandList(cmds)} are still running in this chat's terminals — closing stops them.`, stop: "Stop & close" };
  const name = only?.live && !only.terminal ? AGENT_NAMES[only.live] : undefined;
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
  const [live, setLive] = useState<Record<string, string>>({}); // mount → thread with an open agent session
  const [shells, setShells] = useState<Set<string>>(new Set()); // mounts with a live terminal shell
  const [closing, setClosing] = useState<{ title: string; stop: string } | null>(null);
  const coreStatus = useCoreStatus();
  const [droppedUrl, setDroppedUrl] = useState<ChatDrop | undefined>(undefined);
  // A per-turn memory receipt is tagged with the mount that asked. One for a chat switched away
  // mid-capture follows its thread: shown at once if that thread is back on screen, otherwise held
  // until it's restored. ponytail: held for this window's lifetime only — a receipt for a chat never
  // reopened before the window closes stays in Persona's memory list, not in the chat.
  const evictedRef = useRef(new Map<string, string>()); // evicted mount id → its thread id
  const lateRef = useRef(new Map<string, Array<Array<{ id: string; text: string; category?: string }>>>()); // thread id → receipts
  const onMemoryUpdated = (saved: Array<{ id: string; text: string; category?: string }>, from: string): void => {
    const mounted = sessions.get(from);
    if (mounted) { mounted.memoryUpdated(saved); return; }
    const thread = evictedRef.current.get(from);
    if (thread === undefined) return;
    const holder = [...sessions.values()].find((s) => s.threadId() === thread);
    if (holder) { holder.memoryUpdated(saved); return; }
    lateRef.current.set(thread, [...(lateRef.current.get(thread) ?? []), saved]);
  };
  const takeLateReceipts = (thread: string): Array<Array<{ id: string; text: string; category?: string }>> => {
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
  // Synced chats (Discord/Teams, SyncedChat.tsx): shown over the current desktop chat, which stays
  // mounted (hidden) underneath — picking a desktop row or New chat goes back through it.
  const [synced, setSynced] = useState<SyncedChatListing[]>([]);
  const [syncedShown, setSyncedShownState] = useState<string | undefined>(undefined);
  const syncedRef = useRef<string | undefined>(undefined);
  const setSyncedShown = (key: string | undefined): void => { syncedRef.current = key; setSyncedShownState(key); };
  const [syncedVersion, setSyncedVersion] = useState(0);
  const [syncedWorking, setSyncedWorking] = useState<string | undefined>(undefined);
  const [bots, setBots] = useState<Record<string, boolean>>({});
  const syncedListing = synced.find((c) => syncedKey(c) === syncedShown);
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

  // Layout effect: main's first close is cancelled and only completes through this hand-off, so the
  // listener must exist by the first commit — a passive effect lags it, and a close in that gap is lost.
  useLayoutEffect(() => {
    window.bean.onReviewBeforeClose((quit) => void (quit ? closeAll() : reviewBeforeClose()));
  }, []);

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
    const refreshSynced = (): void => { window.bean.syncedChatList().then((c) => setSynced(c ?? []), () => {}); };
    refreshSynced();
    window.bean.chatopsStatus().then((st) => {
      if (st) setBots({ discord: st.discord.running, teams: st.teams.running });
    }, () => {});
    window.bean.onChatopsEvent((e) => setBots((prev) => ({ ...prev, [e.bot]: e.running })));
    window.bean.onSyncedChatEvent((e) => {
      refreshSynced();
      const shownKey = syncedRef.current;
      const key = e.conversationId === undefined ? undefined : syncedKey({ surface: e.surface, conversationId: e.conversationId });
      if (e.saved && key !== undefined && key !== shownKey) setUnread((prev) => new Set(prev).add(key));
      if (shownKey !== undefined && (key === shownKey || (key === undefined && shownKey.startsWith(`${e.surface}:`)))) {
        setSyncedVersion((v) => v + 1);
      }
    });
    // Pull any URL dropped before this window's renderer finished mounting — the push below
    // (onComponentDroppedUrl) can arrive first and gets silently dropped, same race
    // getPendingPlan fixes for the Plan window.
    window.bean.getPendingDroppedUrl().then((u) => { if (u) { setSyncedShown(undefined); setDroppedUrl(u); } });
    window.bean.onComponentDroppedUrl((u) => { setSyncedShown(undefined); setDroppedUrl(u); });
    // A chat-target skill run confirmed in the Plan popup. Pull + push, same race fix as the dropped URL.
    window.bean.getPendingChatPrompt().then((p) => { if (p) { setSyncedShown(undefined); to()?.runPrompt(p); } });
    window.bean.onChatPrompt((p) => { setSyncedShown(undefined); to()?.runPrompt(p); });
    // A delegate run that was still going when Bean last quit — pull + push, same race fix.
    window.bean.getPendingInterruptedRunNotices().then((n) => { if (n?.length) to()?.notices(n); });
    window.bean.onInterruptedRunNotice((n) => to()?.notices(n));
    window.bean.onDelegateEvent((e) => route(e.mountId)?.delegateEvent(e));
    window.bean.onLiveEvent((e) => route(e.mountId)?.liveEvent(e));
    window.bean.onMemoryUpdated((saved, from) => onMemoryUpdated(saved, from));
    // Progress for a chat that's gone is dropped, never shown in another one.
    window.bean.onChatImageProgress((from) => sessions.get(from)?.imageProgress());
    // An avatar bubble's click: show the chat that owns that task, the way a sidebar pick would.
    window.bean.onShowChatMount((mountId) => {
      // An idle owner may be evicted by now (a finished task's bubble outlives it): its thread reopens.
      // ponytail: a mounted owner with no thread yet (a fresh runPrompt chat) can't be targeted — the
      // switch flow keys on threads; add a mount-level switch if that case shows up in use.
      const thread = sessions.get(mountId)?.threadId() ?? evictedRef.current.get(mountId);
      if (thread !== undefined) openThreadRef.current(thread);
      else if (mountId === shownRef.current) { setOverlayOpen(false); setSyncedShown(undefined); } // not saved yet, but on screen
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

  // Window close: one card for every chat's running tasks; closing writes and remembers each chat.
  const closeAll = async (): Promise<void> => {
    setClosing(null);
    await Promise.all([...sessions.values()].map((s) => s.closeOut()));
    window.bean.allowChatClose();
  };
  const reviewBeforeClose = async (): Promise<void> => {
    const all = await Promise.all([...sessions.values()].map((s) => s.tasks()));
    const busy = all.filter((t) => t.delegates > 0 || t.live || t.terminal);
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
    setLive(({ [mountId]: _, ...rest }) => rest);
    setShells((prev) => { const s = new Set(prev); s.delete(mountId); return s; });
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
    if (synced.some((c) => syncedKey(c) === target)) {
      setSyncedShown(target);
      setUnread((prev) => { const u = new Set(prev); u.delete(target); return u; });
      return;
    }
    const fromSynced = syncedRef.current !== undefined;
    setSyncedShown(undefined);
    // The desktop chat under a synced one is already the pick — just show it again.
    if (fromSynced && target !== "new" && target === activeId) return;
    shownApi()?.open(target);
  };
  // Continue in Discord's switch (and a continued chat's Open thread): the thread's catalog row may be
  // newer than the sidebar list, so it's re-read first. A row the listing doesn't have (the owner
  // changed, or the bot hasn't catalogued it) leaves the desktop chat shown.
  const openSynced = (conversationId: string): void => {
    const key = syncedKey({ surface: "discord", conversationId });
    window.bean.syncedChatList().then((c) => {
      setSynced(c ?? []);
      if (!(c ?? []).some((r) => syncedKey(r) === key)) {
        shownApi()?.error("That Discord thread isn't in the sidebar — check that the Discord bot's owner is still you.");
        return;
      }
      setOverlayOpen(false);
      setSyncedShown(key);
      setUnread((prev) => { const u = new Set(prev); u.delete(key); return u; });
    }, () => {});
  };
  // The mount-once listeners above need the current render's openThread (it reads synced/activeId).
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  // `n` = New chat, only while nothing takes typing (the composer, a search box, an editor).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "n" || e.repeat || e.isComposing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || busyRef.current) return;
      const el = e.target;
      if (el instanceof HTMLElement && (el.isContentEditable || el.closest("input, textarea, select"))) return;
      e.preventDefault();
      openThreadRef.current("new");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Control+` folds/unfolds the shown chat's terminal, Cmd+T / Cmd+1…4 / Cmd+Shift+[ ] drive its
  // tabs — capture phase, so they win over the shell's own keydown (xterm would send NUL) and work
  // from the composer or the terminal alike.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      const tab = tabShortcut(e);
      if (!tab && !isTerminalToggle(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || syncedRef.current !== undefined) return;
      if (tab) shownApi()?.terminalShortcut(tab);
      else shownApi()?.toggleTerminal();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const deleteThread = (id: string): void => {
    window.bean.chatThreadDelete(id).then(
      () => setThreads((prev) => prev.filter((t) => t.id !== id)),
      (err: unknown) => shownApi()?.error(`Couldn't delete that chat: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  // Never re-inserts: a row dropped meanwhile (deleted) stays dropped; undefined = the thread is gone.
  const starThread = (id: string, starred: boolean): Promise<void> => window.bean.chatThreadStar(id, starred).then(
    (updatedAt) => setThreads((prev) => (updatedAt === undefined
      ? prev.filter((t) => t.id !== id)
      : prev.map((t) => (t.id === id ? { ...t, starred, updatedAt, groupName: starred ? t.groupName : null } : t)))),
    (err: unknown) => shownApi()?.error(`Couldn't ${starred ? "star" : "unstar"} that chat: ${err instanceof Error ? err.message : String(err)}`),
  );
  // Same shape as ★. The mounted chat holding the thread (shown or hidden) takes the stored title too,
  // so Continue in Discord proposes it without a reopen.
  const renameThread = (id: string, title: string): Promise<void> => window.bean.chatThreadRename(id, title).then(
    (stored) => {
      if (stored !== undefined) [...sessions.values()].find((s) => s.threadId() === id)?.renamed(stored);
      setThreads((prev) => (stored === undefined
        ? prev.filter((t) => t.id !== id)
        : prev.map((t) => (t.id === id ? { ...t, title: stored } : t))));
    },
    (err: unknown) => shownApi()?.error(`Couldn't rename that chat: ${err instanceof Error ? err.message : String(err)}`),
  );
  // Patches the returned rows; an asked-for row not returned is gone, so it's dropped. Settles with the
  // error message on failure (select mode shows it in its bar too).
  const groupThread = (ids: string[], name: string | null): Promise<string | undefined> => window.bean.chatThreadGroup(ids, name).then(
    (done) => {
      const groupName = name === null ? null : cleanGroupName(name);
      setThreads((prev) => prev.flatMap((t) => (!ids.includes(t.id) ? [t]
        : done.includes(t.id) ? [{ ...t, groupName, starred: name === null ? t.starred : true }] : [])));
      return undefined;
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      shownApi()?.error(`Couldn't ${name === null ? "ungroup" : "group"} ${ids.length === 1 ? "that chat" : "those chats"}: ${msg}`);
      return msg;
    },
  );
  // Same, over the group's members: moved ones take the new name, the rest are gone.
  const renameGroup = (from: string, to: string): Promise<void> => window.bean.chatThreadGroupRename(from, to).then(
    (moved) => {
      const groupName = cleanGroupName(to);
      setThreads((prev) => prev.flatMap((t) => (t.groupName !== from ? [t] : moved.includes(t.id) ? [{ ...t, groupName }] : [])));
    },
    (err: unknown) => shownApi()?.error(`Couldn't rename that group: ${err instanceof Error ? err.message : String(err)}`),
  );

  return (
    <div class="bean-dashboard bean-chat-window">
      <ListFoldToggle folded={!sidebarOpen} onToggle={toggleSidebar} listId="bean-chat-sidebar" name="chat history" />
      {sidebarOpen ? (
        <ChatSidebar
          threads={threads}
          synced={synced}
          activeId={syncedListing ? syncedShown : activeId}
          busy={busy}
          working={new Set([...Object.values(working), ...(syncedWorking ? [syncedWorking] : [])])}
          unread={unread}
          live={new Set(Object.values(live))}
          terminal={new Set([...shells].map((m) => sessions.get(m)?.threadId()).filter((t): t is string => t !== undefined))}
          overlay={narrow}
          onNew={() => openThread("new")}
          onOpen={openThread}
          onDelete={deleteThread}
          onStar={starThread}
          onRename={renameThread}
          onGroup={groupThread}
          onRenameGroup={renameGroup}
        />
      ) : null}
      {mounts.map(({ mountId, restoreId }) => (
        <ChatSession
          key={mountId}
          mountId={mountId}
          restoreId={restoreId}
          sessions={sessions}
          hidden={mountId !== shown || syncedListing !== undefined}
          clis={clis}
          runModels={runModels}
          prefillUrl={mountId === shown ? droppedUrl : undefined}
          setThreads={setThreads}
          onActive={(id) => { if (mountId === shownRef.current) setActiveId(id); }}
          onBusy={(b) => { if (mountId === shownRef.current) setBusy(b); }}
          onWorking={(thread) => setWorking(({ [mountId]: _, ...rest }) => (thread === undefined ? rest : { ...rest, [mountId]: thread }))}
          onLive={(thread) => setLive(({ [mountId]: _, ...rest }) => (thread === undefined ? rest : { ...rest, [mountId]: thread }))}
          onTerminal={(alive) => setShells((prev) => { const s = new Set(prev); if (alive) s.add(mountId); else s.delete(mountId); return s; })}
          onUnread={() => {
            const thread = sessions.get(mountId)?.threadId();
            if (thread !== undefined && (mountId !== shownRef.current || syncedRef.current !== undefined)) setUnread((prev) => new Set(prev).add(thread));
          }}
          takeLateReceipts={takeLateReceipts}
          discordBot={bots.discord === true}
          onOpenSynced={openSynced}
          onSwitch={(target, keep) => switchTo(mountId, target, keep)}
          onEvicted={() => dropMount(mountId)}
        />
      ))}
      {syncedListing ? (
        <SyncedChat
          key={syncedShown}
          listing={syncedListing}
          botRunning={bots[syncedListing.surface] === true}
          version={syncedVersion}
          hasArchive={synced.some((c) => c.surface === syncedListing.surface && c.archivedFrom === syncedListing.conversationId)}
          onWorking={(w) => {
            const key = syncedKey(syncedListing);
            setSyncedWorking((prev) => (w ? key : prev === key ? undefined : prev));
          }}
        />
      ) : null}
      {closing ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">{closing.title}</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => { setClosing(null); window.bean.chatCloseKept(); }}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void stopAndClose()}>{closing.stop}</button>
            </div>
          </div>
        </div>
      ) : null}
      <CoreBar status={coreStatus} />
      {coreStatus.kind === "remote" && coreStatus.state === "mismatch" ? (
        <div class="bean-memory-review" role="alertdialog">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Bean can't talk to {coreStatus.host}</div>
            <p class="bean-core-mismatch">{coreStatus.message}</p>
            {coreStatus.command ? <p class="bean-core-mismatch">Or update the core from a terminal: <code class="bean-cores-command">{coreStatus.command}</code></p> : null}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void window.bean.openComponent("cores")}>Switch core</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
