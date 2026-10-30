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
  /** Bean's reply in flight: rows and New chat wait. */
  busy: boolean;
  overlay: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ChatSidebar({ threads, activeId, busy, overlay, onNew, onOpen, onDelete }: Props) {
  const now = new Date();
  return (
    <nav class={`bean-chat-sidebar${overlay ? " bean-chat-sidebar--overlay" : ""}`} aria-label="Chat history">
      <div class="bean-chat-sidebar-head">
        <button type="button" class="bean-btn bean-chat-sidebar-new" disabled={busy} onClick={onNew}>+ New chat</button>
      </div>
      <div class="bean-chat-sidebar-list">
        {threads.length === 0 ? <div class="bean-chat-sidebar-empty">No saved chats yet.</div> : null}
        {groupThreads(threads, now).map((g) => (
          <>
            <div class="bean-chat-sidebar-group">{g.label}</div>
            {g.threads.map((t) => {
              const active = t.id === activeId;
              const title = t.title || "Untitled chat";
              return (
                <div key={t.id} class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}`}>
                  <button
                    type="button"
                    class="bean-chat-sidebar-open"
                    disabled={busy}
                    aria-current={active ? "true" : undefined}
                    onClick={() => { if (!active) onOpen(t.id); }}
                  >
                    <span class="bean-chat-sidebar-title">{title}</span>
                    <span class="bean-chat-sidebar-meta">
                      {t.agents.filter((a): a is AgentId => a in AGENT_NAMES).map((a) => <AgentAvatar agent={a} size={16} />)}
                      {agoText(t.updatedAt, now)}
                    </span>
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
      <div class="bean-chat-sidebar-foot">Chats older than 90 days are removed. Incognito chats are never kept.</div>
    </nav>
  );
}
