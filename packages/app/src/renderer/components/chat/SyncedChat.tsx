import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DeskRefusal } from "@bean/core";
import { Markdown } from "../../shared/Markdown.js";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { SyncedChatListing, SyncedChatRow } from "../../../synced-chats.js";

/** Renderer copy of core's MAX_DESK_TEXT (desk.ts) — the renderer can't import core values. */
export const MAX_DESK_TEXT = 4000;

export const SURFACE_NAMES = { discord: "Discord", teams: "Teams" } as const;

/** Sidebar/header key for a synced chat — never a UUID, so it can't collide with a desktop thread. */
export const syncedKey = (l: { surface: string; conversationId: string }): string => `${l.surface}:${l.conversationId}`;

/** The kind chip: DM, a thread's name, `#channel`, a Teams post's title — `· live` while a session runs. */
export function kindChip(l: SyncedChatListing): string {
  const base = l.kind === "dm" ? "DM" : l.kind === "channel" ? `#${l.title}` : l.title;
  return l.live ? `${base} · live` : base;
}

export const REFUSAL_TEXT: Record<DeskRefusal, string> = {
  "too-long": `Too long — ${MAX_DESK_TEXT.toLocaleString()} characters at most.`,
  "not-eligible": "This chat belongs to a different owner now — nothing was sent.",
  "queue-full": "The live session has too many messages queued — try again in a moment.",
  "channel-busy": "Someone else is driving the live session here — nothing was sent.",
  "cli-missing": "The bot can't find that agent's CLI — nothing was sent.",
  "no-record": "The bot has no record of this chat — nothing was sent.",
  "post-failed": "Couldn't post the message there — nothing was sent.",
  "bot-busy": "The bot is busy with other desk messages — try again in a moment.",
};

/** Bot down → read-only; a live session → steer; otherwise a Bean turn (after a session ended,
 * the placeholder says so). */
export function composerState(l: SyncedChatListing, botRunning: boolean, rows: SyncedChatRow[]): { readOnly: boolean; placeholder: string } {
  const surface = SURFACE_NAMES[l.surface];
  if (!botRunning) return { readOnly: true, placeholder: `Start the ${surface} bot to continue this chat` };
  if (l.live) return { readOnly: false, placeholder: "Steer the live session…" };
  if (l.liveCli || rows.some((r) => r.role === "agent")) return { readOnly: false, placeholder: "Session ended — Continue live, or message Bean" };
  return { readOnly: false, placeholder: "Message Bean" };
}

const userCount = (rows: SyncedChatRow[], text: string): number =>
  rows.filter((r) => r.role === "user" && !r.name && r.text.trim() === text).length;

interface Props {
  listing: SyncedChatListing;
  botRunning: boolean;
  /** Bumped by the shell when main says this conversation changed — re-reads the transcript. */
  version: number;
  /** A desk turn of ours is waiting for its line to land (the sidebar spinner). */
  onWorking: (working: boolean) => void;
}

/** A Discord/Teams conversation shown in the chat window: its stored transcript, and desk turns
 * sent through the bot. Never saved to desktop history, no incognito, no memory capture — the
 * bot keeps its own (see .memory/project-desktop-chat-history.md → "Synced chats"). */
export function SyncedChat({ listing, botRunning, version, onWorking }: Props) {
  const mountId = useMemo(() => crypto.randomUUID(), []);
  const surface = SURFACE_NAMES[listing.surface];
  const [rows, setRows] = useState<SyncedChatRow[]>([]);
  // Sent, not yet in the transcript: shown as pending bubbles. `seen` = matching lines at send time.
  const [pending, setPending] = useState<Array<{ id: number; text: string; seen: number }>>([]);
  const [errors, setErrors] = useState<Array<{ id: number; text: string }>>([]);
  const [text, setText] = useState("");
  const seq = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.bean.chatAttach(mountId);
    return () => window.bean.chatRelease(mountId);
  }, []);
  useEffect(() => {
    let stale = false;
    window.bean.syncedChatGet(listing.surface, listing.conversationId, mountId).then(
      (next) => {
        if (stale) return;
        setRows(next);
        setPending((p) => p.filter((x) => userCount(next, x.text) <= x.seen));
      },
      (err: unknown) => { if (!stale) setErrors((e) => [...e, { id: ++seq.current, text: `Couldn't load this chat: ${err instanceof Error ? err.message : String(err)}` }]); },
    );
    return () => { stale = true; };
  }, [version]);
  useEffect(() => { onWorking(pending.length > 0); }, [pending.length > 0]);
  useEffect(() => () => onWorking(false), []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, pending, errors]);

  const { readOnly, placeholder } = composerState(listing, botRunning, rows);
  const sendable = (value: string): boolean => !readOnly && value.trim().length > 0 && value.length <= MAX_DESK_TEXT;
  const over = text.length > MAX_DESK_TEXT;

  const send = async (value: string): Promise<void> => {
    if (!sendable(value)) return;
    const trimmed = value.trim();
    const id = ++seq.current;
    setPending((p) => [...p, { id, text: trimmed, seen: userCount(rowsRef.current, trimmed) }]);
    setText("");
    const r = await window.bean.syncedChatSend(listing.surface, listing.conversationId, trimmed, mountId)
      .catch((err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }));
    if ("ok" in r) return;
    setPending((p) => p.filter((x) => x.id !== id));
    setErrors((e) => [...e, {
      id,
      text: "refused" in r ? REFUSAL_TEXT[r.refused]
        : `Not confirmed by the ${surface} bot (${r.failed}). Check ${surface} before sending again.`,
    }]);
  };

  return (
    <div class="bean-chat bean-chat--synced">
      <div class="bean-chat-meta">
        <span class="bean-chat-sidebar-badge">{surface}</span>
        <span class="bean-chat-name">{kindChip(listing)}</span>
      </div>
      <div class="bean-chat-scroll" ref={scrollRef}>
        {rows.length === 0 && pending.length === 0 ? <div class="bean-panel-empty">Nothing here yet.</div> : null}
        {rows.map((r, i) => {
          if (r.role === "user") {
            return (
              <div key={i} class="bean-bubble bean-bubble--user">
                {r.name ? <strong>{r.name}: </strong> : <span class="bean-sr-only">You: </span>}
                {r.text}
              </div>
            );
          }
          if (r.role === "status") return <div key={i} class="bean-status bean-status--info">{r.text}</div>;
          const agent = r.role === "agent" ? r.agent ?? "bean" : "bean";
          return (
            <div key={i} class="bean-chat-row">
              <span class="bean-chat-row-avatar">
                {rows[i - 1]?.role !== r.role ? <AgentAvatar agent={agent} /> : null}
              </span>
              <div class="bean-bubble bean-bubble--bean">
                <span class="bean-sr-only">{AGENT_NAMES[agent]}: </span>
                <Markdown text={r.text} />
              </div>
            </div>
          );
        })}
        {pending.map((p) => (
          <div key={`p${p.id}`} class="bean-bubble bean-bubble--user bean-bubble--pending">
            <span class="bean-sr-only">You (sending): </span>
            {p.text}
          </div>
        ))}
        {pending.length > 0 ? (
          <div class="bean-chat-row">
            <span class="bean-chat-row-avatar"><AgentAvatar agent="bean" bob /></span>
            <div class="bean-bubble bean-bubble--bean bean-bubble--working">Sent to {surface}<span class="bean-dots"><span /><span /><span /></span></div>
          </div>
        ) : null}
        {errors.map((e) => <div key={`e${e.id}`} class="bean-status bean-status--error">{e.text}</div>)}
      </div>
      <div class="bean-chat-input">
        {!botRunning ? (
          <div class="bean-status bean-status--info">The {surface} bot isn't running — start it in Settings to continue this chat here.</div>
        ) : listing.live ? (
          <div class="bean-agent-banner">
            <span class="bean-agent-banner-dot" aria-hidden="true">●</span>
            <span>Live session running — your messages steer it</span>
          </div>
        ) : null}
        <div class="bean-chat-input-shell">
          <textarea
            class="bean-input bean-input--composer"
            rows={1}
            placeholder={placeholder}
            disabled={readOnly}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // The textarea's own value: a key can land before the input event's re-render.
                void send(e.currentTarget.value);
              }
            }}
          />
          <div class="bean-chat-composer-bar">
            <span class={`bean-chat-synced-count${over ? " bean-chat-synced-count--over" : ""}`}>
              {text.length.toLocaleString()} / {MAX_DESK_TEXT.toLocaleString()}
            </span>
            <button type="button" class="bean-send" aria-label="Send" disabled={!sendable(text)} onClick={() => void send(text)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </button>
          </div>
        </div>
        <div class="bean-chat-synced-foot">Cards, approvals and memory receipts stay in {surface}.</div>
      </div>
    </div>
  );
}
