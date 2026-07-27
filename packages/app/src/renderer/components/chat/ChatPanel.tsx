import { useEffect, useRef, useState } from "preact/hooks";
import { ProposalCard, type PickableModel } from "../../shared/ProposalCard.js";
import { Markdown } from "../../shared/Markdown.js";
import { NoteCard } from "./NoteCard.js";
import { SkillCard } from "./SkillCard.js";
import { TodoCard } from "./TodoCard.js";
import { DelegateCard } from "./DelegateCard.js";
import { imageFileGuard, insertDroppedPath, type ChatItem } from "../../shared/chat-types.js";
import type { CliName, ImageAttachment, LinkedNote, Project, ProposedNote, ProposedSkill, RouteSuggestion, Skill } from "@bean/core";

/** Read a picked image into an attachment + full data URL for its composer thumbnail. */
function readImageFile(file: File): Promise<{ attachment: ImageAttachment; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      resolve({ attachment: { data: base64, mimeType: file.type }, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Full-size preview for a chat image. Native `<dialog>`, so the backdrop, Esc-to-close and
 * focus trapping come from the platform — click the image to toggle fit ↔ 1:1 zoom.
 */
function ImagePreview({ image, onClose }: { image: { dataUrl: string; path?: string }; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog
      ref={ref}
      class="bean-image-preview"
      aria-label="Image preview"
      onClose={onClose}
      // A click landing on the dialog itself (not its content) is a backdrop click.
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      {/* Button, not a bare img: the zoom toggle has to be reachable by keyboard too. */}
      <button
        type="button"
        class={`bean-image-preview-img${zoomed ? " bean-image-preview-img--zoom" : ""}`}
        title={zoomed ? "Fit to window" : "Zoom to full size"}
        aria-pressed={zoomed}
        onClick={() => setZoomed((z) => !z)}
      >
        <img src={image.dataUrl} alt="image preview" />
      </button>
      <div class="bean-image-preview-actions">
        {image.path ? (
          <button type="button" class="bean-btn" onClick={() => window.bean.revealInFinder(image.path!)}>Show in Finder</button>
        ) : null}
        <button type="button" class="bean-btn bean-btn--ghost" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}

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
  skills,
  onSend,
  onConfirm,
  onCancel,
  onNoteSave,
  onNoteDismiss,
  onSkillSave,
  onSkillDismiss,
  onTodoQueue,
  onTodoDismiss,
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
  // Full current skill list — SkillCard uses it to live-recompute "replaces existing"
  // against the user's edited name, not just the model's originally-proposed one.
  skills: Skill[];
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onConfirm: (
    id: string,
    editedPrompt: string,
    run: RouteSuggestion,
    choice: { cli?: CliName; projectPath?: string; model?: string },
  ) => void;
  onCancel: (id: string) => void;
  onNoteSave: (id: string, edited: ProposedNote, asNew: boolean) => void;
  onNoteDismiss: (id: string) => void;
  onSkillSave: (id: string, edited: ProposedSkill) => void;
  onSkillDismiss: (id: string) => void;
  onTodoQueue: (id: string) => void;
  onTodoDismiss: (id: string) => void;
  onDelegateConfirm: (id: string, editedPrompt: string, model?: string) => void;
  onDelegateDismiss: (id: string) => void;
  onDelegateCancelTask: (id: string) => void;
  onSaveToNotes: () => void;
  onUnlink: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingImages, setPendingImages] = useState<Array<{ attachment: ImageAttachment; dataUrl: string }>>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // FileReader is async — a submit racing an unfinished read would send the text without its
  // image (and orphan the image onto the next turn). Submit blocks while any read is in flight.
  const [imageReadsInFlight, setImageReadsInFlight] = useState(0);
  // Clicked transcript image, shown full-size in the overlay. Generated images carry a `path`
  // (so they also offer "Show in Finder"); pasted/dropped ones only exist as a data URL.
  const [preview, setPreview] = useState<{ dataUrl: string; path?: string } | null>(null);

  // Slots reserved by accepted-but-still-reading files. A ref, not state: a second paste
  // arriving before the first batch's FileReaders resolve must see those reservations
  // synchronously, or the two batches together can exceed the per-message cap.
  const reservedSlotsRef = useRef(0);

  const attachImageFiles = (files: File[]): void => {
    // Stale errors clear at the start of a new attempt — never on individual read success,
    // which would wipe a same-batch rejection message before the user can read it.
    setImageError(null);
    for (const file of files) {
      const problem = imageFileGuard(file.type, file.size, pendingImages.length + reservedSlotsRef.current);
      if (problem) { setImageError(problem); continue; }
      reservedSlotsRef.current += 1;
      setImageReadsInFlight((n) => n + 1);
      void readImageFile(file)
        .then((img) => {
          setPendingImages((prev) => [...prev, img]);
        })
        .catch(() => setImageError("Couldn't read that image."))
        .finally(() => {
          reservedSlotsRef.current -= 1;
          setImageReadsInFlight((n) => n - 1);
        });
    }
  };
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
    if (!el || imageReadsInFlight > 0) return;
    // Image-only sends are allowed; converse still needs some text on the turn.
    const text = el.value.trim() || (pendingImages.length > 0 ? "(image)" : "");
    if (!text) return;
    el.value = "";
    resizeInput();
    const images = pendingImages.map((p) => p.attachment);
    setPendingImages([]);
    setImageError(null);
    onSend(text, images.length > 0 ? images : undefined);
  };

  const droppedPath = (e: DragEvent): string | undefined => {
    const file = e.dataTransfer?.files?.[0];
    return file ? window.bean.getPathForFile(file) : undefined;
  };

  const dropPathIntoComposer = (e: DragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])];
    // Image files become attachments (Bean can see them); everything else keeps the
    // existing insert-the-path behavior for project/URL drops.
    if (files.length > 0 && files.every((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      attachImageFiles(files);
      return;
    }
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

  const pasteImages = (e: ClipboardEvent): void => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return; // plain text paste — leave it to the textarea
    e.preventDefault();
    attachImageFiles(files);
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
          if (it.kind === "user") {
            return (
              <div key={it.id} class="bean-bubble bean-bubble--user">
                {it.display ?? it.text}
                {it.images?.map((src) => (
                  <button type="button" class="bean-chat-thumb" title="Preview" onClick={() => setPreview({ dataUrl: src })}>
                    <img src={src} alt="attached image" />
                  </button>
                ))}
              </div>
            );
          }
          if (it.kind === "reply") {
            return (
              <div key={it.id} class="bean-bubble bean-bubble--bean">
                <Markdown text={it.display ?? it.text} />
                {it.images?.map((img) => (
                  <button
                    type="button"
                    class="bean-chat-thumb"
                    title="Preview"
                    onClick={() => setPreview({ dataUrl: img.dataUrl, path: img.path })}
                  >
                    <img src={img.dataUrl} alt="generated image" />
                  </button>
                ))}
              </div>
            );
          }
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
          if (it.kind === "skill") {
            return (
              <SkillCard
                key={it.id}
                skill={it.skill}
                skills={skills}
                state={it.state}
                onSave={(edited) => onSkillSave(it.id, edited)}
                onDismiss={() => onSkillDismiss(it.id)}
              />
            );
          }
          if (it.kind === "todo") {
            return (
              <TodoCard
                key={it.id}
                todo={it.todo}
                state={it.state}
                onQueue={() => onTodoQueue(it.id)}
                onDismiss={() => onTodoDismiss(it.id)}
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
                cliOptions={clis}
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
        {imageError ? <div class="bean-status bean-status--error">{imageError}</div> : null}
        {pendingImages.length > 0 ? (
          <div class="bean-chat-pending-images">
            {pendingImages.map((img, i) => (
              <span class="bean-chat-pending-image">
                <img src={img.dataUrl} alt="pending attachment" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                >✕</button>
              </span>
            ))}
          </div>
        ) : null}
        <div class="bean-chat-input-shell">
          <textarea
            ref={inputRef}
            class="bean-input bean-input--composer"
            rows={1}
            placeholder="Message Bean…"
            disabled={busy}
            onInput={resizeInput}
            onPaste={pasteImages}
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
          <button type="button" class="bean-send" aria-label="Send" disabled={busy || imageReadsInFlight > 0} onClick={submit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </button>
        </div>
      </div>
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
