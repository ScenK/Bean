import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ProposalCard, type PickableModel } from "../../shared/ProposalCard.js";
import { Markdown } from "../../shared/Markdown.js";
import { NoteCard } from "./NoteCard.js";
import { SkillCard } from "./SkillCard.js";
import { TodoCard } from "./TodoCard.js";
import { LiveOfferCard } from "./LiveOfferCard.js";
import { DelegateCard } from "./DelegateCard.js";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { imageFileGuard, insertDroppedPath, itemAgent, startsAgentRun, type AgentId, type ChatItem } from "../../shared/chat-types.js";
import { HANDOFF_ITEMS, canContinueLive, handoffItems, isLiveAgent, offerAgent } from "./agent-mode.js";
import { SECTION_TITLES, slashMenu, type SlashEntry } from "./slash-commands.js";
import type { CliName, ImageAttachment, LiveCli, LinkedNote, Project, ProposedNote, ProposedSkill, Routine, RouteSuggestion, Skill } from "@bean/core";

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
        // Explicit label: without it the accessible name falls through to the child img's alt,
        // which says nothing about this being the zoom toggle.
        aria-label="Toggle full-size zoom"
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
  sprouts,
  delegateCli,
  onSlashOpen,
  onSend,
  onConfirm,
  onCancel,
  onNoteSave,
  onNoteDismiss,
  onSkillSave,
  onSkillDismiss,
  onTodoQueue,
  onTodoDismiss,
  onOfferStart,
  onOfferDismiss,
  onDelegateConfirm,
  onDelegateDismiss,
  onDelegateCancelTask,
  onContinueLive,
  onSaveToNotes,
  onUnlink,
  incognito,
  onToggleIncognito,
  onMemoryUndo,
  mode,
  agentProject,
  live,
  onPickAgent,
  onPickProject,
  onEndAgent,
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
  // The `/` menu's sprouts; onSlashOpen refreshes both catalogs each time the menu opens.
  sprouts: Routine[];
  /** Settings' delegate CLI preference — a terminal skill's `/` caption names the CLI main picks. */
  delegateCli: string;
  onSlashOpen: () => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onConfirm: (
    id: string,
    editedPrompt: string,
    run: RouteSuggestion,
    choice: { cli?: CliName; projectPath?: string; model?: string },
  ) => void;
  onCancel: (id: string) => void;
  onNoteSave: (id: string, edited: ProposedNote, asNew: boolean, images?: string[]) => void;
  onNoteDismiss: (id: string) => void;
  onSkillSave: (id: string, edited: ProposedSkill) => void;
  onSkillDismiss: (id: string) => void;
  onTodoQueue: (id: string) => void;
  onTodoDismiss: (id: string) => void;
  onOfferStart: (id: string) => void;
  onOfferDismiss: (id: string) => void;
  onDelegateConfirm: (id: string, editedPrompt: string, model?: string) => void;
  onDelegateDismiss: (id: string) => void;
  onDelegateCancelTask: (id: string) => void;
  onContinueLive: (id: string) => void;
  onSaveToNotes: () => void;
  onUnlink: () => void;
  // Off the record: nothing from this chat is remembered at close.
  incognito: boolean;
  onToggleIncognito: () => void;
  onMemoryUndo: (id: string) => void;
  // Agent mode: who answers typed text, the project an agent would start in ("" = scratch), and
  // the window's running session (busy = a turn is in flight; the composer stays usable).
  mode: AgentId;
  agentProject: string;
  live?: { agent: LiveCli; projectPath: string; busy: boolean; continuing?: boolean };
  onPickAgent: (agent: AgentId) => void;
  onPickProject: (path: string) => void;
  onEndAgent: () => void;
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

  const agentMode = mode !== "bean";
  const liveAgents = clis.filter(isLiveAgent);
  const agentName = AGENT_NAMES[mode];
  const projectName = (path: string): string => projects.find((p) => p.path === path)?.name ?? "scratch";
  // The `/` menu: the composer text while it's a lone `/word` ("" = closed), and the picked row.
  const [slashText, setSlashText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  // Hidden while Bean answers, like the chip — switching mid-turn isn't allowed.
  const menu = slashText && !busy
    ? slashMenu(slashText, mode, { agents: liveAgents, skills, sprouts, delegate: { projects, clis, models: runModels, delegateCli, lastUsedModels } })
    : undefined;
  const pickable = menu?.entries ?? [];
  const activeEntry = pickable.length ? pickable[((slashIndex % pickable.length) + pickable.length) % pickable.length] : undefined;
  const onComposerInput = (value: string): void => {
    const next = /^\/\S*$/.test(value) ? value : "";
    if (next && !slashText) onSlashOpen();
    if (next !== slashText) setSlashIndex(0);
    setSlashText(next);
  };
  // Agents take text only — anything pending was meant for Bean.
  useEffect(() => { if (agentMode) setPendingImages([]); }, [agentMode]);

  const attachImageFiles = (files: File[]): void => {
    // Stale errors clear at the start of a new attempt — never on individual read success,
    // which would wipe a same-batch rejection message before the user can read it.
    setImageError(null);
    if (agentMode) { setImageError(`${agentName} takes text only — switch to Bean to share an image.`); return; }
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

  // Grow/shrink the composer with its content (Shift+Enter adds lines). The cap is the CSS
  // `max-height` on .bean-input--composer alone — past it the textarea scrolls.
  const resizeInput = (): void => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  // Keep the slash menu's current pick in view once the list outgrows its max-height.
  const slashMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashMenuRef.current?.querySelector(".bean-chip-menu-row--on")?.scrollIntoView?.({ block: "nearest" });
  }, [slashText, slashIndex]);

  useEffect(() => {
    const el = inputRef.current;
    if (!prefillUrl || !el) return;
    // Prepend so a drop never clobbers whatever the user was already typing.
    el.value = el.value ? `${prefillUrl} ${el.value}` : `${prefillUrl} `;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    resizeInput();
  }, [prefillUrl]);

  // A chat mounts with the composer focused — the window's first chat and every switched-to one.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = (): void => {
    const el = inputRef.current;
    // Type-ahead: while Bean answers the draft and images stay put — return before clearing.
    if (!el || busy || imageReadsInFlight > 0) return;
    // Image-only sends are allowed; converse still needs some text on the turn.
    const text = el.value.trim() || (pendingImages.length > 0 ? "(image)" : "");
    if (!text) return;
    el.value = "";
    resizeInput();
    setSlashText("");
    const images = pendingImages.map((p) => p.attachment);
    setPendingImages([]);
    setImageError(null);
    onSend(text, images.length > 0 ? images : undefined);
  };

  // A menu pick runs its command as if typed: an agent switches, a skill runs with no instruction.
  const pickEntry = (entry: SlashEntry): void => {
    if (!inputRef.current) return;
    inputRef.current.value = entry.command;
    submit();
    inputRef.current.focus();
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

  // The newest run's avatar bobs while a turn is in flight — toggled on turn start/stop, not per chunk.
  const lastRunStart = items.findLastIndex((_, i) => startsAgentRun(items, i));
  // Reply/working bubbles sit in a row behind their agent's avatar, shown once per run of
  // consecutive same-agent bubbles (later ones keep the empty slot so they stay aligned).
  const agentRow = (it: ChatItem, i: number, bubble: ComponentChildren) => {
    const agent = itemAgent(it) ?? "bean";
    return (
      <div key={it.id} class="bean-chat-row">
        <span class="bean-chat-row-avatar">
          {startsAgentRun(items, i) ? <AgentAvatar agent={agent} bob={(busy || live?.busy === true) && i === lastRunStart} /> : null}
        </span>
        {bubble}
      </div>
    );
  };
  const speaker = (it: ChatItem) => <span class="bean-sr-only">{AGENT_NAMES[itemAgent(it) ?? "bean"]}: </span>;

  return (
    <div class="bean-chat">
      {/* Pinned below the drag band, not inside it — no drag region here. */}
      <div class="bean-chat-meta">
        <AgentAvatar agent="bean" size={18} />
        <span class="bean-chat-name">Bean</span>
        <span class="bean-chat-status">
          <span class={`bean-chat-state bean-chat-state--${status}`} />
          {status}
        </span>
        <span class="bean-chat-meta-spacer" />
        {/* The linked-note chip replaces the model id (mockup 1d) — both don't fit. */}
        {linkedNote ? (
          <span class="bean-chat-notechip" title={`Saving from this chat updates "${linkedNote.title}" in place`}>
            <span class="bean-chat-notechip-title">{linkedNote.title}</span> · v{linkedNote.version}
            <button type="button" class="bean-chat-unlink" aria-label="Unlink note" onClick={onUnlink}>✕</button>
          </span>
        ) : (
          <span class="bean-chat-model">{model}</span>
        )}
        <span class="bean-chat-meta-divider" />
        <button
          type="button"
          role="switch"
          class={`bean-chat-incognito${incognito ? " bean-chat-incognito--on" : ""}`}
          aria-checked={incognito}
          title={incognito ? "This chat won't be remembered or kept in history" : "Off the record — also removes this chat from history."}
          onClick={onToggleIncognito}
        >
          <span class="bean-switch" aria-hidden="true" />
          Off the record
        </button>
      </div>
      <div class="bean-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <div class="bean-panel-empty">Ask Bean to do something, or just say hi.</div>
        ) : null}
        {items.map((it, i) => {
          if (it.kind === "user") {
            return (
              <div key={it.id} class="bean-bubble bean-bubble--user">
                <span class="bean-sr-only">You: </span>
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
            return agentRow(it, i, (
              <div class="bean-bubble bean-bubble--bean">
                {speaker(it)}
                {it.streaming && !it.text ? <span class="bean-bubble--working">Working<span class="bean-dots"><span /><span /><span /></span></span> : null}
                {it.text || it.display ? <Markdown text={it.display ?? it.text} /> : null}
                {it.tail?.length ? (
                  <details class="bean-agent-tail">
                    <summary>{it.tail.length} step{it.tail.length === 1 ? "" : "s"}</summary>
                    <pre>{it.tail.join("\n")}</pre>
                  </details>
                ) : null}
                {it.footer ? <div class="bean-agent-footer">{it.footer}</div> : null}
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
            ));
          }
          if (it.kind === "working") {
            return agentRow(it, i, (
              <div class="bean-bubble bean-bubble--bean bean-bubble--working">{speaker(it)}{it.text}<span class="bean-dots"><span /><span /><span /></span></div>
            ));
          }
          if (it.kind === "status") {
            if (it.receipt) {
              return (
                <div key={it.id} class={`bean-status bean-status--${it.tone}`}>
                  {it.text}
                  {canContinueLive(it, clis, !!live) ? (
                    <>
                      {" · "}
                      <button type="button" class="bean-status-action" disabled={!!it.exiting}
                        title={it.exiting ? "Waiting for the agent to exit…" : it.receipt.label} onClick={() => onContinueLive(it.id)}>
                        Continue live
                      </button>
                    </>
                  ) : null}
                </div>
              );
            }
            if (!it.details?.length) return <div key={it.id} class={`bean-status bean-status--${it.tone}`}>{it.text}</div>;
            return (
              <details key={it.id} class={`bean-status bean-status--${it.tone} bean-status--details`}>
                <summary>{it.text} ▸</summary>
                {it.details.map((d) => <div class="bean-status-detail">{d}</div>)}
              </details>
            );
          }
          if (it.kind === "memory") {
            const facts = it.saved.map((m) => m.text).join("; ");
            return (
              <div key={it.id} class={`bean-status bean-status--${it.state === "undone" ? "info" : "done"}`}>
                {it.state === "undone" ? `Forgot: ${facts}` : `Remembered: ${facts}`}
                {it.state === "undone" || it.state === "kept" ? null : (
                  <button type="button" class="bean-status-action" disabled={it.state === "undoing"} onClick={() => onMemoryUndo(it.id)}>Undo</button>
                )}
              </div>
            );
          }
          if (it.kind === "note") {
            return (
              <NoteCard
                key={it.id}
                note={it.note}
                state={it.state}
                linkedVersion={it.note.slug !== undefined && it.note.slug === linkedNote?.slug ? linkedNote.version : undefined}
                images={it.images}
                onSave={(edited, asNew, images) => onNoteSave(it.id, edited, asNew, images)}
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
          if (it.kind === "offer") {
            return (
              <LiveOfferCard
                key={it.id}
                offer={it.offer}
                agent={offerAgent(clis)}
                projectName={projectName(it.offer.projectPath)}
                state={it.state}
                onStart={() => onOfferStart(it.id)}
                onDismiss={() => onOfferDismiss(it.id)}
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
                browser={skills.find((s) => s.name === it.proposal.skillName)?.browser === true}
                onConfirm={(edited, model) => onDelegateConfirm(it.id, edited, model)}
                onDismiss={() => onDelegateDismiss(it.id)}
                onCancelTask={() => onDelegateCancelTask(it.id)}
                onContinueLive={canContinueLive(it, clis, !!live) ? () => onContinueLive(it.id) : undefined}
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
      <div class="bean-chat-input">
        {showJump ? (
          <button type="button" class="bean-jump-down" aria-label="Jump to latest" onClick={scrollToBottom}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>
          </button>
        ) : null}
        {live ? (
          <div class="bean-agent-banner">
            <span class="bean-agent-banner-dot" aria-hidden="true">●</span>
            {live.continuing ? <span>Continuing</span> : null}
            <AgentAvatar agent={live.agent} size={16} />
            <span>{AGENT_NAMES[live.agent]} · {projectName(live.projectPath)}</span>
            <button type="button" class="bean-status-action" onClick={onEndAgent}>End</button>
          </div>
        ) : null}
        {agentMode && incognito ? (
          <div class="bean-status bean-status--info">Off the record covers Bean only — {agentName} keeps its own transcript.</div>
        ) : null}
        {menu && (menu.entries.length > 0 || menu.more > 0) ? (
          <div ref={slashMenuRef} class="bean-chip-menu-list bean-slash-menu" role="listbox" aria-label="Commands">
            {menu.entries.map((e, i) => (
              <>
                {e.kind !== menu.entries[i - 1]?.kind ? <div class="bean-chip-menu-hint">{SECTION_TITLES[e.kind]}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={e === activeEntry}
                  class={`bean-chip-menu-row${e === activeEntry ? " bean-chip-menu-row--on" : ""}`}
                  // Keep focus in the composer so Enter/Tab still reach it after a hover-click.
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pickEntry(e)}
                >
                  <span class="bean-chip-menu-row-title">
                    {e.kind === "agent" ? <AgentAvatar agent={e.name as AgentId} size={16} /> : null} {e.command}{" "}
                    <span class="bean-chip-menu-caption">{e.caption}</span>
                  </span>
                </button>
              </>
            ))}
            {menu.more > 0 ? <div class="bean-chip-menu-hint">+{menu.more} more</div> : null}
          </div>
        ) : null}
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
            placeholder={!agentMode ? "Message Bean · type / for skills" : live
              ? `Message ${agentName}…`
              : `Message ${agentName}… (Bean will hand over up to ${Math.min(handoffItems(items).filter((h) => h.text.trim()).length, HANDOFF_ITEMS)} messages)`}
            onInput={(e) => { resizeInput(); onComposerInput((e.target as HTMLTextAreaElement).value); }}
            onPaste={pasteImages}
            onDragOver={(e) => { if (droppedPath(e)) e.preventDefault(); }}
            onDrop={dropPathIntoComposer}
            onKeyDown={(e) => {
              // IME-safe: Enter/arrows while composing belong to the input method.
              if (e.isComposing || e.keyCode === 229) return;
              if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const at = activeEntry ? pickable.indexOf(activeEntry) : 0;
                setSlashIndex(at + (e.key === "ArrowDown" ? 1 : -1));
                return;
              }
              if (menu && e.key === "Escape") { e.preventDefault(); setSlashText(""); return; }
              if (activeEntry && e.key === "Tab") {
                e.preventDefault();
                const el = e.currentTarget;
                el.value = `${activeEntry.command} `;
                onComposerInput(el.value);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (activeEntry) pickEntry(activeEntry);
                else submit();
              }
            }}
          />
          <div class="bean-chat-composer-bar">
            <ChipMenu
              disabled={busy}
              chipClass="bean-agent-chip"
              chipLabel={<><AgentAvatar agent={mode} size={16} /> {agentName}{agentMode ? ` · ${projectName(live?.projectPath ?? agentProject)}` : ""}</>}
            >
              {(close) => (
                <div class="bean-chip-menu-list">
                  {(["bean", ...liveAgents] as AgentId[]).map((a) => (
                    <button
                      type="button"
                      class={`bean-chip-menu-row${a === mode ? " bean-chip-menu-row--on" : ""}`}
                      onClick={() => { onPickAgent(a); close(); }}
                    >
                      <span class="bean-chip-menu-row-title"><AgentAvatar agent={a} size={16} /> {AGENT_NAMES[a]}</span>
                    </button>
                  ))}
                  {liveAgents.length > 0 ? (
                    <>
                      <div class="bean-chip-menu-divider" />
                      <div class="bean-chip-menu-hint">Agents work in</div>
                      {[{ path: "", name: "No project — scratch workspace" }, ...projects].map((p) => (
                        <button
                          type="button"
                          class={`bean-chip-menu-row${p.path === agentProject ? " bean-chip-menu-row--on" : ""}${p.path ? "" : " bean-chip-menu-row--no-project"}`}
                          onClick={() => { onPickProject(p.path); close(); }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </>
                  ) : null}
                </div>
              )}
            </ChipMenu>
            <button
              type="button"
              class="bean-save-notes"
              title="Ask Bean to draft a note from this conversation"
              disabled={busy || !items.some((it) => it.kind === "reply")}
              onClick={onSaveToNotes}
            >Save to notes</button>
            <button type="button" class="bean-send" aria-label="Send" disabled={busy || imageReadsInFlight > 0} onClick={submit}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </button>
          </div>
        </div>
      </div>
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
