import type { DesktopChatListing } from "@bean/core";
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

/** Today (local calendar day) and Earlier, newest first as listed; empty groups dropped. */
export function groupThreads<T extends { updatedAt: string }>(threads: T[], now: Date): Array<{ label: string; threads: T[] }> {
  const isToday = (iso: string): boolean => new Date(iso).toDateString() === now.toDateString();
  return [
    { label: "Today", threads: threads.filter((t) => isToday(t.updatedAt)) },
    { label: "Earlier", threads: threads.filter((t) => !isToday(t.updatedAt)) },
  ].filter((g) => g.threads.length > 0);
}

/** The list after a save ack: the active thread moves to the top with its new title, time and agents.
 * No push channel — this ack is the only live update. */
export function withSaveAck(threads: DesktopChatListing[], ack: ChatThreadAck, items: ChatItem[]): DesktopChatListing[] {
  const agents = [...new Set(items.flatMap((it) => (it.kind === "reply" && it.agent && it.agent !== "bean" ? [it.agent] : [])))];
  return [{ ...ack, agents }, ...threads.filter((t) => t.id !== ack.id)];
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
  overlay: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Row time: "now"/"3h" today, "Oct 28" before that. */
export function rowTime(iso: string, now: Date): string {
  if (new Date(iso).toDateString() !== now.toDateString()) {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return agoText(iso, now).replace("just now", "now").replace(" ago", "");
}

export function ChatSidebar({ threads, synced, activeId, busy, working, unread, overlay, onNew, onOpen, onDelete }: Props) {
  const now = new Date();
  const rows = mergeRows(threads, synced);
  const marker = (key: string) => (working.has(key)
    ? <span class="bean-chat-sidebar-spinner" role="img" aria-label="Working" />
    : unread.has(key) ? <span class="bean-chat-sidebar-dot" role="img" aria-label="New reply" /> : null);
  return (
    <nav class={`bean-chat-sidebar${overlay ? " bean-chat-sidebar--overlay" : ""}`} aria-label="Chat history">
      <div class="bean-chat-sidebar-head">All chats · {rows.length}</div>
      <div class="bean-chat-sidebar-list">
        {rows.length === 0 ? <div class="bean-chat-sidebar-empty">No saved chats yet.</div> : null}
        {groupThreads(rows, now).map((g) => (
          <>
            <div class="bean-chat-sidebar-group"><span>{g.label}</span><span>{g.threads.length}</span></div>
            {g.threads.map((row) => {
              if (row.synced) {
                const active = row.key === activeId;
                const surface = SURFACE_NAMES[row.chat.surface];
                return (
                  <div key={row.key} class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}`}>
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
              return (
                <div key={t.id} class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}`}>
                  <button
                    type="button"
                    class="bean-chat-sidebar-open"
                    disabled={busy}
                    aria-current={active ? "true" : undefined}
                    onClick={() => { if (!active) onOpen(t.id); }}
                  >
                    <span class="bean-chat-sidebar-line">
                      <span class="bean-chat-sidebar-title">{title}</span>
                      {active ? null : agents.map((a) => <AgentAvatar agent={a} size={12} />)}
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
                  </button>
                  {active ? null : (
                    <button type="button" class="bean-chat-sidebar-row-delete" aria-label={`Delete "${title}"`} title="Delete" onClick={() => onDelete(t.id)}>✕</button>
                  )}
                </div>
              );
            })}
          </>
        ))}
      </div>
      <button type="button" class="bean-btn bean-chat-sidebar-new" disabled={busy} onClick={onNew}>+ New chat</button>
      <div class="bean-chat-sidebar-foot">Kept 90 days · incognito chats never kept</div>
    </nav>
  );
}
