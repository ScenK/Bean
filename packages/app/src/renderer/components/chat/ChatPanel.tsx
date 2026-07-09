import { useEffect, useRef, useState } from "preact/hooks";
import { ProposalCard, type PickableModel } from "../../shared/ProposalCard.js";
import { Markdown } from "../../shared/Markdown.js";
import { NoteCard } from "./NoteCard.js";
import { DelegateCard } from "./DelegateCard.js";
import { insertDroppedPath, type ChatItem } from "../../shared/chat-types.js";
import type { CliName, LinkedNote, Project, ProposedNote, RouteSuggestion } from "@bean/core";

export function ChatPanel({
  items,
  busy,
  model,
  status,
  prefillUrl,
  linkedNote,
  clis,
  projects,
  runModels,
  lastUsedModels,
  onSend,
  onConfirm,
  onCancel,
  onNoteSave,
  onNoteDismiss,
  onDelegateConfirm,
  onDelegateDismiss,
  onDelegateCancelTask,
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
  // Run-choice data for ProposalCard/DelegateCard's project/model/CLI pickers.
  clis: CliName[];
  projects: Project[];
  runModels: PickableModel[];
  lastUsedModels: Record<string, string>;
  onSend: (text: string) => void;
  onConfirm: (
    id: string,
    editedPrompt: string,
    run: RouteSuggestion,
    choice: { cli: CliName; projectPath?: string; model?: string },
  ) => void;
  onCancel: (id: string) => void;
  onNoteSave: (id: string, edited: ProposedNote, asNew: boolean) => void;
  onNoteDismiss: (id: string) => void;
  onDelegateConfirm: (id: string, editedPrompt: string, model?: string) => void;
  onDelegateDismiss: (id: string) => void;
  onDelegateCancelTask: (id: string) => void;
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

  const droppedPath = (e: DragEvent): string | undefined => {
    const file = e.dataTransfer?.files?.[0];
    return file ? window.bean.getPathForFile(file) : undefined;
  };

  const dropPathIntoComposer = (e: DragEvent): void => {
    const path = droppedPath(e);
    if (!path || !inputRef.current) return;
    e.preventDefault();
    const el = inputRef.current;
    const next = insertDroppedPath(el.value, path, el.selectionStart, el.selectionEnd);
    el.value = next.value;
    el.focus();
    el.setSelectionRange(next.cursor, next.cursor);
    resizeInput();
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
          if (it.kind === "delegate") {
            // Same "assigned skills, else every project" fallback used for the sibling
            // ProposalCard below — resolves the project chip to a name instead of a raw path.
            const assignedDelegate = it.proposal.skillName
              ? projects.filter((p) => p.skills?.includes(it.proposal.skillName!))
              : [];
            return (
              <DelegateCard
                key={it.id}
                item={it}
                modelOptions={runModels}
                projectOptions={assignedDelegate.length > 0 ? assignedDelegate : projects}
                onConfirm={(edited, model) => onDelegateConfirm(it.id, edited, model)}
                onDismiss={() => onDelegateDismiss(it.id)}
                onCancelTask={() => onDelegateCancelTask(it.id)}
              />
            );
          }
          // Same "assigned skills, else every project" fallback PlanWindow uses for its picker.
          const assigned = projects.filter((p) => p.skills?.includes(it.run.skillName));
          return (
            <ProposalCard
              key={it.id}
              run={it.run}
              state={it.state}
              cliOptions={clis}
              projectOptions={assigned.length > 0 ? assigned : projects}
              modelOptions={runModels}
              lastUsedModel={lastUsedModels[it.run.skillName]}
              onConfirm={(edited, choice) => onConfirm(it.id, edited, it.run, choice)}
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
            onDragOver={(e) => { if (droppedPath(e)) e.preventDefault(); }}
            onDrop={dropPathIntoComposer}
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
