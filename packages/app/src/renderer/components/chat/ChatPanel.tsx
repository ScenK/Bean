import { useEffect, useRef, useState } from "preact/hooks";
import { ProposalCard } from "../../shared/ProposalCard.js";
import { Markdown } from "../../shared/Markdown.js";
import { NoteCard } from "./NoteCard.js";
import type { ChatItem } from "../../shared/chat-types.js";
import type { LinkedNote, ProposedNote, RouteSuggestion } from "@bean/core";

export function ChatPanel({
  items,
  busy,
  model,
  status,
  prefillUrl,
  linkedNote,
  onSend,
  onConfirm,
  onCancel,
  onNoteSave,
  onNoteDismiss,
  onSaveToNotes,
  onUnlink,
}: {
  items: ChatItem[];
  busy: boolean;
  model: string;
  status: "idle" | "working" | "done" | "error";
  // A path/URL just dropped on the avatar's box (no skill chosen) — inserted as literal,
  // editable text so the user can see it and add instructions before sending, rather than
  // silently riding along as hidden context on whatever they type next.
  prefillUrl?: string;
  // The note this chat continues from (header chip; ✕ unlinks so saves become new notes).
  linkedNote?: LinkedNote;
  onSend: (text: string) => void;
  onConfirm: (id: string, editedPrompt: string, run: RouteSuggestion) => void;
  onCancel: (id: string) => void;
  onNoteSave: (id: string, edited: ProposedNote, asNew: boolean) => void;
  onNoteDismiss: (id: string) => void;
  onSaveToNotes: () => void;
  onUnlink: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // "Near bottom" tracked in a ref (the scroll handler runs constantly); the jump-down
  // button is state because it renders.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  };

  // GPT-style follow: a message the user just sent always snaps to the bottom; anything
  // arriving while scrolled up shows the ↓ pill instead of yanking the view.
  useEffect(() => {
    if (items.length === 0) return;
    if (atBottomRef.current || items.at(-1)?.kind === "user") scrollToBottom();
    else setShowJump(true);
  }, [items]);

  // Grow/shrink the composer with its content (Shift+Enter adds lines), capped so a long
  // paste doesn't swallow the transcript.
  const resizeInput = (): void => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!prefillUrl || !el) return;
    // Prepend so a drop never clobbers whatever the user was already typing.
    el.value = el.value ? `${prefillUrl} ${el.value}` : `${prefillUrl} `;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    resizeInput();
  }, [prefillUrl]);

  const submit = (): void => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    el.value = "";
    resizeInput();
    onSend(text);
  };

  return (
    <div class="bean-chat">
      <div class="bean-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div class="bean-chat-meta">
          <span class="bean-chat-avatar" />
          <span class="bean-chat-name">Bean</span>
          <span class={`bean-chat-state bean-chat-state--${status}`} />
          <span>{status}</span>
          <span class="bean-chat-meta-spacer" />
          {/* The linked-note chip replaces the model chip (mockup 1d) — both don't fit. */}
          {linkedNote ? (
            <span class="bean-chip bean-chat-notechip" title={`Saving from this chat updates "${linkedNote.title}" in place`}>
              📝 <span class="bean-chat-notechip-title">{linkedNote.title}</span> · v{linkedNote.version}
              <button type="button" class="bean-chat-unlink" aria-label="Unlink note" onClick={onUnlink}>✕</button>
            </span>
          ) : (
            <span class="bean-chat-model">{model}</span>
          )}
        </div>
        {items.length === 0 ? (
          <div class="bean-panel-empty">Ask Bean to do something, or just say hi.</div>
        ) : null}
        {items.map((it) => {
          if (it.kind === "user") return <div key={it.id} class="bean-bubble bean-bubble--user">{it.display ?? it.text}</div>;
          if (it.kind === "reply") return <div key={it.id} class="bean-bubble bean-bubble--bean"><Markdown text={it.text} /></div>;
          if (it.kind === "working") return <div key={it.id} class="bean-bubble bean-bubble--bean bean-bubble--working">{it.text}<span class="bean-dots"><span /><span /><span /></span></div>;
          if (it.kind === "status") return <div key={it.id} class={`bean-status bean-status--${it.tone}`}>{it.text}</div>;
          if (it.kind === "note") {
            return (
              <NoteCard
                key={it.id}
                note={it.note}
                state={it.state}
                linkedVersion={it.note.slug !== undefined && it.note.slug === linkedNote?.slug ? linkedNote.version : undefined}
                onSave={(edited, asNew) => onNoteSave(it.id, edited, asNew)}
                onDismiss={() => onNoteDismiss(it.id)}
              />
            );
          }
          return (
            <ProposalCard
              key={it.id}
              run={it.run}
              state={it.state}
              onConfirm={(edited) => onConfirm(it.id, edited, it.run)}
              onCancel={() => onCancel(it.id)}
            />
          );
        })}
      </div>
      {showJump ? (
        <button type="button" class="bean-jump-down" aria-label="Jump to latest" onClick={scrollToBottom}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>
        </button>
      ) : null}
      <div class="bean-chat-input">
        <div class="bean-chat-input-shell">
          <textarea
            ref={inputRef}
            class="bean-input bean-input--composer"
            rows={1}
            placeholder="Message Bean…"
            disabled={busy}
            onInput={resizeInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button
            type="button"
            class="bean-save-notes"
            title="Ask Bean to draft a note from this conversation"
            disabled={busy || !items.some((it) => it.kind === "reply")}
            onClick={onSaveToNotes}
          >📝 Save to notes</button>
          <button type="button" class="bean-send" aria-label="Send" disabled={busy} onClick={submit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
