import type { DesktopChatListing } from "@bean/core";
import { Fragment } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId, ChatItem } from "../../shared/chat-types.js";
import type { ChatThreadAck } from "../../../ipc.js";
import { agoText } from "../routines/watch-status.js";
import type { SyncedChatListing } from "../../../synced-chats.js";
import { kindChip, SURFACE_NAMES, syncedKey } from "./SyncedChat.js";

/** Below this window width the sidebar is an overlay (always opening collapsed). */
export const SIDEBAR_INLINE_MIN = 640;
/** Inline mode's remembered collapse toggle ("0" = collapsed). */
export const SIDEBAR_OPEN_KEY = "bean.chat.sidebarOpen";

/** Today, then the two most recent earlier days with activity ("Nov 2", "Oct 31"), then Earlier —
 * by local calendar day, in listed (newest-first) order; empty groups dropped. */
export function groupThreads<T extends { updatedAt: string }>(threads: T[], now: Date): Array<{ label: string; threads: T[] }> {
  const groups: Array<{ label: string; threads: T[] }> = [];
  const earlier: T[] = [];
  let days = 0;
  for (const t of threads) {
    const d = new Date(t.updatedAt);
    const label = d.toDateString() === now.toDateString() ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.threads.push(t);
    else if (label === "Today" || days < 2) { groups.push({ label, threads: [t] }); if (label !== "Today") days++; }
    else earlier.push(t);
  }
  return earlier.length > 0 ? [...groups, { label: "Earlier", threads: earlier }] : groups;
}

/** The list after a save ack: the active thread moves to the top with its new title, time and agents.
 * No push channel — this ack is the only live update. */
export function withSaveAck(threads: DesktopChatListing[], ack: ChatThreadAck, items: ChatItem[]): DesktopChatListing[] {
  const agents = [...new Set(items.flatMap((it) => (it.kind === "reply" && it.agent && it.agent !== "bean" ? [it.agent] : [])))];
  const old = threads.find((t) => t.id === ack.id);
  return [{ starred: false, groupName: null, ...old, ...ack, agents }, ...threads.filter((t) => t.id !== ack.id)];
}

/** One sidebar list: desktop threads and synced (Discord/Teams) chats, newest first. Stable, so
 * desktop threads keep their listed order among equal times. */
export type SidebarRow = { synced: false; key: string; updatedAt: string; thread: DesktopChatListing }
  | { synced: true; key: string; updatedAt: string; chat: SyncedChatListing };
export function mergeRows(threads: DesktopChatListing[], synced: SyncedChatListing[]): SidebarRow[] {
  return [
    ...threads.map((t): SidebarRow => ({ synced: false, key: t.id, updatedAt: t.updatedAt, thread: t })),
    ...synced.map((c): SidebarRow => ({ synced: true, key: syncedKey(c), updatedAt: c.updatedAt, chat: c })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

interface Props {
  threads: DesktopChatListing[];
  /** The owner's Discord/Teams conversations — opened read/continue, never deleted from here. */
  synced: SyncedChatListing[];
  activeId: string | undefined;
  /** The shown chat's switch-away save in flight: rows and New chat wait. */
  busy: boolean;
  /** Threads with work in flight (a spinner) and with a reply that landed while hidden (a dot). */
  working: Set<string>;
  unread: Set<string>;
  /** Threads with an open agent (live) session: a green wash and a breathing dot before the title. */
  live: Set<string>;
  /** Threads whose chat holds a live terminal shell: a calm `>_` (a dev server never finishes, so no spinner). */
  terminal: Set<string>;
  overlay: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Settles (never rejects) once the list reflects the result; focus then returns to the row's ★. */
  onStar: (id: string, starred: boolean) => Promise<void>;
  /** Settles (never rejects) once the list reflects the result; focus then returns to the row's ✎. */
  onRename: (id: string, title: string) => Promise<void>;
}

/** Starred desktop threads first as one never-folded group (newest first), then the date groups
 * over everything else. Synced chats are never starred. */
export function sidebarGroups(rows: SidebarRow[], now: Date): Array<{ label: string; threads: SidebarRow[] }> {
  const isStarred = (r: SidebarRow): boolean => !r.synced && r.thread.starred;
  const starred = rows.filter(isStarred);
  const rest = groupThreads(rows.filter((r) => !isStarred(r)), now);
  return starred.length > 0 ? [{ label: "Starred", threads: starred }, ...rest] : rest;
}

/** Row time: "now"/"3h" today, "Oct 28" before that. */
export function rowTime(iso: string, now: Date): string {
  if (new Date(iso).toDateString() !== now.toDateString()) {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return agoText(iso, now).replace("just now", "now").replace(" ago", "");
}

export function ChatSidebar({ threads, synced, activeId, busy, working, unread, live, terminal, overlay, onNew, onOpen, onDelete, onStar, onRename }: Props) {
  const now = new Date();
  const rows = mergeRows(threads, synced);
  // Earlier starts folded each time the sidebar mounts; the open chat stays visible inside it.
  const [earlierOpen, setEarlierOpen] = useState(false);
  // A row that moved (a save ack lifts its thread to the top) slides from where it was (FLIP).
  const listRef = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === false; // false in jsdom (no matchMedia)
    const next = new Map(els.map((el) => [el.dataset.row!, el.offsetTop]));
    for (const el of els) {
      const was = tops.current.get(el.dataset.row!);
      const dy = was === undefined ? 0 : was - el.offsetTop;
      if (motion && dy !== 0) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    tops.current = next;
  });
  // After a star toggle or a rename the row may have changed group (remounted): put focus back on its
  // ★ / ✎, or on the Earlier fold when the row is folded away or gone.
  const [refocus, setRefocus] = useState<{ id: string; control: "star" | "rename" } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!refocus) return;
    const list = listRef.current;
    (list?.querySelector<HTMLElement>(`[data-row="${refocus.id}"] .bean-chat-sidebar-row-${refocus.control}`)
      ?? list?.querySelector<HTMLElement>(".bean-chat-sidebar-group--fold"))?.focus();
  }, [refocus]);
  // Rename drafts by thread id, so a save ack (a new title, a moved row) mid-edit doesn't lose one.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const endEdit = (id: string): void => setDrafts(({ [id]: _, ...rest }) => rest);
  const cancelEdit = (id: string): void => { endEdit(id); setRefocus({ id, control: "rename" }); };
  // Enter or blur: an empty or unchanged title just ends the edit. The ref guards Enter's later blur.
  const saveEdit = (id: string, current: string): void => {
    const { [id]: draft, ...rest } = draftsRef.current;
    if (draft === undefined) return;
    draftsRef.current = rest;
    const title = draft.trim();
    if (!title || title === current) { cancelEdit(id); return; }
    endEdit(id);
    void onRename(id, title).then(() => setRefocus({ id, control: "rename" }));
  };
  const marker = (key: string) => (working.has(key)
    ? <span class="bean-chat-sidebar-spinner" role="img" aria-label="Working" />
    : unread.has(key) ? <span class="bean-chat-sidebar-dot" role="img" aria-label="New reply" /> : null);
  return (
    <nav id="bean-chat-sidebar" class={`bean-chat-sidebar${overlay ? " bean-chat-sidebar--overlay" : ""}`} aria-label="Chat history">
      <div class="bean-chat-sidebar-head">All chats · {rows.length}</div>
      <div class="bean-chat-sidebar-list" ref={listRef}>
        {rows.length === 0 ? <div class="bean-chat-sidebar-empty">No saved chats yet.</div> : null}
        {sidebarGroups(rows, now).map((g) => (
          <Fragment key={g.label}>
            {g.label === "Earlier" ? (
              <button type="button" class="bean-chat-sidebar-group bean-chat-sidebar-group--fold" aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}>
                <span><span class="bean-chat-sidebar-chevron" aria-hidden="true">{earlierOpen ? "▾" : "▸"}</span> {g.label}</span><span>{g.threads.length}</span>
              </button>
            ) : <div class="bean-chat-sidebar-group"><span>{g.label}</span><span>{g.threads.length}</span></div>}
            {(g.label === "Earlier" && !earlierOpen ? g.threads.filter((row) => row.key === activeId) : g.threads).map((row) => {
              if (row.synced) {
                const active = row.key === activeId;
                const surface = SURFACE_NAMES[row.chat.surface];
                return (
                  <div key={row.key} data-row={row.key} class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}`}>
                    <button
                      type="button"
                      class="bean-chat-sidebar-open"
                      disabled={busy}
                      aria-current={active ? "true" : undefined}
                      onClick={() => { if (!active) onOpen(row.key); }}
                    >
                      <span class="bean-chat-sidebar-line">
                        <span class="bean-chat-sidebar-badge">{surface}</span>
                        <span class="bean-chat-sidebar-title">{kindChip(row.chat)}</span>
                        {marker(row.key)}
                        <span class="bean-chat-sidebar-time">{rowTime(row.updatedAt, now)}</span>
                      </span>
                    </button>
                  </div>
                );
              }
              const t = row.thread;
              const active = t.id === activeId;
              const title = t.title || "Untitled chat";
              const agents = t.agents.filter((a): a is AgentId => a in AGENT_NAMES);
              const draft = drafts[t.id];
              return (
                <div
                  key={t.id}
                  data-row={t.id}
                  class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}${live.has(t.id) ? " bean-chat-sidebar-row--live" : ""}`}
                  onKeyDown={(e) => {
                    if (e.key !== "F2" || draft !== undefined) return;
                    e.preventDefault();
                    setDrafts((d) => ({ ...d, [t.id]: t.title }));
                  }}
                >
                  {draft !== undefined ? (
                    <RenameInput
                      value={draft}
                      label={`Rename "${title}"`}
                      onInput={(v) => setDrafts((d) => (t.id in d ? { ...d, [t.id]: v } : d))}
                      onSave={() => saveEdit(t.id, t.title)}
                      onCancel={() => cancelEdit(t.id)}
                    />
                  ) : <button
                    type="button"
                    class="bean-chat-sidebar-open"
                    disabled={busy}
                    aria-current={active ? "true" : undefined}
                    onClick={() => { if (!active) onOpen(t.id); }}
                  >
                    <span class="bean-chat-sidebar-line">
                      {live.has(t.id) ? <span class="bean-chat-sidebar-live" role="img" aria-label="Agent session running" /> : null}
                      <span class="bean-chat-sidebar-title">{title}</span>
                      {active ? null : agents.map((a) => <AgentAvatar agent={a} size={12} />)}
                      {terminal.has(t.id) ? <span class="bean-chat-sidebar-term" role="img" aria-label="Terminal open">&gt;_</span> : null}
                      {marker(t.id)}
                      <span class="bean-chat-sidebar-time">{rowTime(t.updatedAt, now)}</span>
                    </span>
                    {active ? (
                      <span class="bean-chat-sidebar-meta">
                        <AgentAvatar agent="bean" size={12} />
                        {agents.map((a) => <AgentAvatar agent={a} size={12} />)}
                        {["Bean", ...agents.map((a) => AGENT_NAMES[a])].join(" · ")}
                      </span>
                    ) : null}
                  </button>}
                  {draft !== undefined ? null : (
                    <button
                      type="button"
                      class="bean-chat-sidebar-row-rename"
                      aria-label={`Rename "${title}"`}
                      title="Rename (F2)"
                      onClick={() => setDrafts((d) => ({ ...d, [t.id]: t.title }))}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    type="button"
                    class={`bean-notes-star bean-chat-sidebar-row-star${t.starred ? " bean-notes-star--on" : ""}`}
                    aria-pressed={t.starred}
                    aria-label={`${t.starred ? "Unstar" : "Star"} "${title}"`}
                    title={t.starred ? "Unstar chat (starred chats can't be deleted)" : "Star chat"}
                    onClick={() => { void onStar(t.id, !t.starred).then(() => setRefocus({ id: t.id, control: "star" })); }}
                  >
                    {"\u2605"}
                  </button>
                  {active || t.starred ? null : (
                    <button type="button" class="bean-chat-sidebar-row-delete" aria-label={`Delete "${title}"`} title="Delete" onClick={() => onDelete(t.id)}>✕</button>
                  )}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      <button type="button" class="bean-btn bean-chat-sidebar-new" disabled={busy} onClick={onNew}>+ New chat</button>
      <div class="bean-chat-sidebar-foot">Kept 90 days unless starred · incognito chats never kept</div>
    </nav>
  );
}

/** A desktop row's title editor: focused and selected on mount (again if its row remounts). Escape is
 * default-prevented so the overlay sidebar stays open. */
function RenameInput({ value, label, onInput, onSave, onCancel }: {
  value: string; label: string; onInput: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      class="bean-chat-sidebar-rename"
      value={value}
      aria-label={label}
      onInput={(e) => onInput(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); onSave(); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      // A remount (the row changed group) blurs a detached node — that's not the user leaving.
      onBlur={(e) => { if (e.currentTarget.isConnected) onSave(); }}
    />
  );
}
