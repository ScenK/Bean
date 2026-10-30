import type { DesktopChatListing } from "@bean/core";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId, ChatItem } from "../../shared/chat-types.js";
import type { ChatThreadAck } from "../../../ipc.js";
import { agoText } from "../routines/watch-status.js";

/** Below this window width the sidebar is an overlay (always opening collapsed). */
export const SIDEBAR_INLINE_MIN = 640;
/** Inline mode's remembered collapse toggle ("0" = collapsed). */
export const SIDEBAR_OPEN_KEY = "bean.chat.sidebarOpen";

/** Today (local calendar day) and Earlier, newest first as listed; empty groups dropped. */
export function groupThreads(threads: DesktopChatListing[], now: Date): Array<{ label: string; threads: DesktopChatListing[] }> {
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

interface Props {
  threads: DesktopChatListing[];
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

export function ChatSidebar({ threads, activeId, busy, working, unread, overlay, onNew, onOpen, onDelete }: Props) {
  const now = new Date();
  return (
    <nav class={`bean-chat-sidebar${overlay ? " bean-chat-sidebar--overlay" : ""}`} aria-label="Chat history">
      <div class="bean-chat-sidebar-head">All chats · {threads.length}</div>
      <div class="bean-chat-sidebar-list">
        {threads.length === 0 ? <div class="bean-chat-sidebar-empty">No saved chats yet.</div> : null}
        {groupThreads(threads, now).map((g) => (
          <>
            <div class="bean-chat-sidebar-group"><span>{g.label}</span><span>{g.threads.length}</span></div>
            {g.threads.map((t) => {
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
                      {working.has(t.id)
                        ? <span class="bean-chat-sidebar-spinner" role="img" aria-label="Working" />
                        : unread.has(t.id) ? <span class="bean-chat-sidebar-dot" role="img" aria-label="New reply" /> : null}
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
