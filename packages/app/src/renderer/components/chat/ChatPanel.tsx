import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, RefObject } from "preact";
import { ProposalCard, type PickableModel } from "../../shared/ProposalCard.js";
import { Markdown } from "../../shared/Markdown.js";
import { NoteCard } from "./NoteCard.js";
import { SkillCard } from "./SkillCard.js";
import { TodoCard } from "./TodoCard.js";
import { SproutRunCard } from "./SproutRunCard.js";
import { SendCard } from "./SendCard.js";
import { LiveOfferCard } from "./LiveOfferCard.js";
import { DelegateCard } from "./DelegateCard.js";
import { TerminalPane, type TabShortcut } from "./TerminalPane.js";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { MAX_IMAGES_PER_MESSAGE, PDF_MIME, PDF_NO_PATH, formatSize, imageFileGuard, pdfFileGuard, insertDroppedPath, readImageFile, itemAgent, type PinnedPdf, startsAgentRun, type AgentId, type ChatItem } from "../../shared/chat-types.js";
import {
  HANDOFF_ITEMS, agentModels, canContinueLive, chatHeader, handoffItems, imageLabel, isLiveAgent, mappedImageLabels, offerAgent, parseSlash, type ImageLabels,
} from "./agent-mode.js";
import { SECTION_TITLES, slashMenu, type SlashEntry } from "./slash-commands.js";
import { useCmdLinks } from "./chat-links.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import type { CliName, ImageAttachment, LiveCli, LinkedNote, Project, ProposedNote, ProposedSkill, RouteSuggestion, Skill } from "@bean/core";
import type { ChatDrop, DroppedImage } from "../../../channels.js";

/** Esc Esc: the window for the second press. */
const ESC_STOP_MS = 800;

/** The running turn Stop / Esc Esc ends — the live agent's (banner) or Bean's own (working row).
 * `key` changes with every turn, so an Esc armed for one never stops the next. */
export interface StopTarget { key: string; kind: "live" | "bean"; stopping: boolean }

/** An image to attach, wherever it came from; `path` = its file on disk, "" when it has none. */
interface ImageSource { type: string; size: number; path: string; read: () => Promise<{ attachment: ImageAttachment; dataUrl: string }> }
/** A PDF to pin, wherever it came from; `read` resolves to its base64 payload. */
interface PdfSource { size: number; filename: string; path: string; read: () => Promise<string> }

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
  hidden,
  mountId,
  inputRef,
  terminalOpen,
  onToggleTerminal,
  onTerminalOpen,
  onShells,
  terminalShortcut,
  items,
  busy,
  model,
  status,
  prefillUrl,
  refill,
  linkedNote,
  clis,
  projects,
  runModels,
  lastUsedModels,
  skills,
  delegateCli,
  onSlashOpen,
  onSend,
  pdf,
  onAttachPdf,
  onRemovePdf,
  imageLabels,
  onImageLabel,
  onStageImage,
  onConfirm,
  onCancel,
  onNoteSave,
  onNoteDismiss,
  onSkillSave,
  onSkillDismiss,
  onTodoQueue,
  onTodoDismiss,
  onSproutTrigger,
  onSproutDismiss,
  onSendConfirm,
  onSendDismiss,
  onOfferStart,
  onOfferDismiss,
  onDelegateConfirm,
  autoFocusDelegateId,
  onDelegateDismiss,
  onDelegateCancelTask,
  onContinueLive,
  onSaveToNotes,
  onUnlink,
  incognito,
  onToggleIncognito,
  continueButton,
  continued,
  onOpenContinued,
  onMemoryUndo,
  onForgetUndo,
  mode,
  agentProject,
  agentModel,
  live,
  offerLaunch,
  onPickAgent,
  onPickProject,
  onPickModel,
  onEndAgent,
  stopTarget,
  onStopTurn,
}: {
  /** A chat kept mounted in the background while another one is shown. */
  hidden?: boolean;
  /** This chat's mount: its terminal pane's shell is keyed by it. */
  mountId: string;
  /** The composer, owned by ChatSession: an unsent draft keeps the chat mounted on a switch. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onTerminalOpen: (open: boolean) => void;
  onShells: (count: number) => void;
  terminalShortcut: { current: ((s: TabShortcut) => void) | null };
  items: ChatItem[];
  busy: boolean;
  model: string;
  status: "idle" | "working" | "done" | "error";
  // A path/URL just dropped on the avatar's box (no skill chosen) — inserted as literal,
  // editable text so the user can see it and add instructions before sending, rather than
  // silently riding along as hidden context on whatever they type next. Image files attach the
  // way a drop on the composer does.
  prefillUrl?: ChatDrop;
  // Text the chat hands back to the composer (a Continue live the host rejected), above any draft.
  refill?: { text: string };
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
  /** Settings' delegate CLI preference — a terminal skill's `/` caption names the CLI main picks. */
  delegateCli: string;
  onSlashOpen: () => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  /** The chat's pinned PDF (Bean mode only): `sent` once a turn carried it. */
  pdf?: { filename: string; size: number; sent: boolean };
  onAttachPdf: (pdf: PinnedPdf) => void;
  onRemovePdf: () => void;
  /** Agent mode's `[Image #N]` → file map (chat-scoped, read-only here). */
  imageLabels: ImageLabels;
  /** Maps `path` to a fresh `[Image #N]` for `agent`; `composer` = the text it lands in (numbering). */
  onImageLabel: (path: string, composer: string, agent: LiveCli) => string;
  /** Writes a pasted/dragged image to a private temp file; its path. */
  onStageImage: (img: ImageAttachment) => Promise<string>;
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
  onSproutTrigger: (id: string) => void;
  onSproutDismiss: (id: string) => void;
  onSendConfirm: (id: string, optionId: string) => void;
  onSendDismiss: (id: string) => void;
  onOfferStart: (id: string) => void;
  onOfferDismiss: (id: string) => void;
  onDelegateConfirm: (id: string, editedPrompt: string, choice: { projectPath: string; model?: string; cli?: CliName }) => void;
  /** The delegate card a `/` send just created — the only card that takes focus. */
  autoFocusDelegateId?: string;
  onDelegateDismiss: (id: string) => void;
  onDelegateCancelTask: (id: string) => void;
  onContinueLive: (id: string) => void;
  onSaveToNotes: () => void;
  onUnlink: () => void;
  // Off the record: nothing from this chat is remembered at close.
  incognito: boolean;
  onToggleIncognito: () => void;
  /** Continue in Discord's header button (ContinueDiscord), when this chat may offer it. */
  continueButton?: ComponentChildren;
  /** The thread this chat moved to: read-only, Open thread instead of a composer. */
  continued?: { title: string };
  onOpenContinued?: () => void;
  onMemoryUndo: (id: string) => void;
  onForgetUndo: (id: string) => void;
  // Agent mode: who answers typed text, the project an agent would start in ("" = scratch), and
  // the window's running session (busy = a turn is in flight; the composer stays usable).
  mode: AgentId;
  agentProject: string;
  /** The model the next fresh start uses ("" = the agent's default) — already checked against clis.json. */
  agentModel: string;
  /** `model` = what the running session launched with (unset = the agent's default). */
  live?: { agent: LiveCli; projectPath: string; model?: string; busy: boolean; continuing?: boolean; stopping?: boolean };
  /** What a hand-off offer's Start launches (the same function startOffer uses). */
  offerLaunch: (offerPath: string) => { projectPath: string; model?: string };
  onPickAgent: (agent: AgentId) => void;
  onPickProject: (path: string) => void;
  onPickModel: (model: string) => void;
  onEndAgent: () => void;
  stopTarget?: StopTarget;
  /** Stop `stopTarget`; a live session stays (banner / working-row Stop, composer Esc Esc). */
  onStopTurn: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useCmdLinks(scrollRef, mountId);
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
  const modelName = (id: string): string => runModels.find((m) => m.id === id)?.label ?? id;
  // The chip names the running session's actual model, else the next start's; none = the default.
  const chipModel = live ? live.model : agentModel;
  // The `/` menu: the composer text while it's a lone `/word` ("" = closed), and the picked row.
  const [slashText, setSlashText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  // Hidden while Bean answers, like the chip — switching mid-turn isn't allowed.
  const menu = slashText && !busy
    ? slashMenu(slashText, mode, { agents: liveAgents, skills, delegate: { projects, clis, models: runModels, delegateCli, lastUsedModels } })
    : undefined;
  const pickable = menu ?? [];
  const activeEntry = pickable.length ? pickable[((slashIndex % pickable.length) + pickable.length) % pickable.length] : undefined;
  // Esc Esc stops the running turn: the first press arms (and still reaches an overlay's Escape),
  // a second within ESC_STOP_MS stops. Anything else in between disarms. The arm holds the target's
  // key, so it is derived away (not reset by an effect, which could run after the next press) the
  // moment another turn takes over — a same-tick hand-off is never stopped by a leftover arm.
  const [escArmedKey, setEscArmedKey] = useState<string | undefined>(undefined);
  const escTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarmEsc = (): void => { clearTimeout(escTimer.current); setEscArmedKey(undefined); };
  const canStop = stopTarget !== undefined && !stopTarget.stopping;
  const escArmed = canStop && escArmedKey === stopTarget.key;
  const escHint = (kind: StopTarget["kind"]) =>
    escArmed && stopTarget?.kind === kind ? <span class="bean-agent-banner-hint">Esc again to stop</span> : null;
  useEffect(() => () => clearTimeout(escTimer.current), []);
  const onComposerInput = (value: string): void => {
    const next = /^\/\S*$/.test(value) ? value : "";
    if (next && !slashText) onSlashOpen();
    if (next !== slashText) setSlashIndex(0);
    setSlashText(next);
  };
  // Agent mode (#628): an image is an `[Image #N]` label in the composer, mapped to a file the agent
  // reads by path. Inserted at the cursor as it is when the label is ready.
  const insertImageLabel = (path: string, agent: LiveCli): void => {
    const el = inputRef.current;
    if (!el) return;
    const next = insertDroppedPath(el.value, onImageLabel(path, el.value, agent), el.selectionStart, el.selectionEnd);
    el.value = next.value;
    el.focus();
    el.setSelectionRange(next.cursor, next.cursor);
    resizeInput();
  };
  // The agent-mode cap counts the labels still in the composer, plus stages in flight.
  const labelsInComposer = (): number => mappedImageLabels(inputRef.current?.value ?? "", imageLabels).length + reservedSlotsRef.current;
  const stageIntoLabel = (img: ImageAttachment, agent: LiveCli): void => {
    reservedSlotsRef.current += 1;
    setImageReadsInFlight((n) => n + 1);
    void onStageImage(img)
      .then((path) => insertImageLabel(path, agent))
      .catch(() => setImageError("Couldn't attach that image."))
      .finally(() => {
        reservedSlotsRef.current -= 1;
        setImageReadsInFlight((n) => n - 1);
      });
  };

  // Bean's pending chips carried into an agent (a mode switch) become labels.
  useEffect(() => {
    if (!isLiveAgent(mode) || pendingImages.length === 0) return;
    const carried = pendingImages;
    setPendingImages([]);
    setImageError(null);
    for (const img of carried) {
      if (labelsInComposer() >= MAX_IMAGES_PER_MESSAGE) { setImageError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`); break; }
      stageIntoLabel(img.attachment, mode);
    }
  }, [mode, pendingImages.length]);

  // A composer drop/paste and an avatar drop (DroppedImage) take the same path, so both attach alike.
  const attachImageFiles = (files: File[]): void =>
    attachImages(files.map((file) => ({ type: file.type, size: file.size, path: window.bean.getPathForFile(file), read: () => readImageFile(file) })));
  const attachDropped = (dropped: DroppedImage[]): void => {
    const pdfs = dropped.filter((d) => d.mimeType === PDF_MIME);
    const images = dropped.filter((d) => d.mimeType !== PDF_MIME);
    if (images.length > 0) attachDroppedImages(images);
    else setImageError(null);
    if (agentMode) { insertPdfPaths(pdfs.map((d) => d.path)); return; }
    attachPdfs(pdfs.map((d) => ({
      size: d.size, filename: d.path.split("/").pop() ?? "", path: d.path,
      read: () => (d.data === undefined ? Promise.reject(new Error("not read")) : Promise.resolve(d.data)),
    })));
  };
  // Agent mode: an agent reads a PDF by path, so each goes in as text, like any other dropped file —
  // never staged, never sent to Bean. One with no path (a paste, a browser drag) gets the notice.
  const insertPdfPaths = (paths: string[]): void => {
    const el = inputRef.current;
    const real = paths.filter(Boolean);
    if (el && real.length > 0) {
      el.value = `${real.join(" ")} ${el.value}`;
      resizeInput();
    }
    if (real.length < paths.length) setImageError(PDF_NO_PATH);
  };
  const attachDroppedImages = (images: DroppedImage[]): void =>
    attachImages(images.map(({ path, mimeType, size, data }) => ({
      type: mimeType, size, path,
      read: () => data === undefined
        ? Promise.reject(new Error("not read"))
        : Promise.resolve({ attachment: { data, mimeType }, dataUrl: `data:${mimeType};base64,${data}` }),
    })));
  const attachImages = (sources: ImageSource[]): void => {
    // Stale errors clear at the start of a new attempt — never on individual read success,
    // which would wipe a same-batch rejection message before the user can read it.
    setImageError(null);
    const agent = isLiveAgent(mode) ? mode : undefined;
    for (const src of sources) {
      const problem = imageFileGuard(src.type, src.size, agent ? labelsInComposer() : pendingImages.length + reservedSlotsRef.current);
      if (problem) { setImageError(problem); continue; }
      // A Finder file is labeled with its own path — nothing is copied. A paste or a browser drag
      // has no path, so it is staged first.
      if (agent && src.path) { insertImageLabel(src.path, agent); continue; }
      reservedSlotsRef.current += 1;
      setImageReadsInFlight((n) => n + 1);
      void src.read()
        .then((img) => {
          if (agent) stageIntoLabel(img.attachment, agent);
          else setPendingImages((prev) => [...prev, img]);
        })
        .catch(() => setImageError("Couldn't read that image."))
        .finally(() => {
          reservedSlotsRef.current -= 1;
          setImageReadsInFlight((n) => n - 1);
        });
    }
  };
  // One PDF per chat (Bean mode): read, then handed to ChatSession, which pins it. A drop holding
  // two is refused outright. Doesn't clear the error row — attachFiles does, once per drop.
  const attachPdfs = (sources: PdfSource[]): void => {
    const src = sources[0];
    if (!src) return;
    const problem = pdfFileGuard(src.size, sources.length);
    if (problem) { setImageError(problem); return; }
    setImageReadsInFlight((n) => n + 1);
    void src.read()
      .then((data) => onAttachPdf({ data, filename: src.filename || "document.pdf", size: src.size, path: src.path }))
      .catch(() => setImageError("Couldn't read that PDF."))
      .finally(() => setImageReadsInFlight((n) => n - 1));
  };
  // PDFs attach in Bean mode only; an agent gets a PDF's path as text instead.
  const isPdf = (type: string): boolean => !agentMode && type === PDF_MIME;
  const attachFiles = (files: File[]): void => {
    const images = files.filter((f) => f.type !== PDF_MIME);
    if (images.length > 0) attachImageFiles(images);
    else setImageError(null);
    const pdfs = files.filter((f) => f.type === PDF_MIME).map((f) => ({
      size: f.size, filename: f.name, path: window.bean.getPathForFile(f), read: () => readImageFile(f).then(({ attachment }) => attachment.data),
    }));
    if (agentMode) insertPdfPaths(pdfs.map((p) => p.path));
    else attachPdfs(pdfs);
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
    if (Array.isArray(prefillUrl)) { attachDropped(prefillUrl); return; }
    // Prepend so a drop never clobbers whatever the user was already typing.
    el.value = el.value ? `${prefillUrl} ${el.value}` : `${prefillUrl} `;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    resizeInput();
  }, [prefillUrl]);

  useEffect(() => {
    const el = inputRef.current;
    if (!refill || !el) return;
    el.value = el.value ? `${refill.text}\n${el.value}` : refill.text;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    resizeInput();
  }, [refill]);

  // A chat mounts with the composer focused — the window's first chat and every switched-to one.
  useEffect(() => { if (!hidden) inputRef.current?.focus(); }, [hidden]);
  // Folding the terminal hands focus back to the composer (the pane focuses its shell on open).
  const termMounted = useRef(false);
  useEffect(() => {
    if (!termMounted.current) { termMounted.current = true; return; }
    if (!terminalOpen && !hidden) inputRef.current?.focus();
  }, [terminalOpen]);

  const submit = (): void => {
    const el = inputRef.current;
    // Type-ahead: while Bean answers the draft and images stay put — return before clearing.
    if (!el || busy || imageReadsInFlight > 0) return;
    // An agent's image labels mean nothing to Bean: refuse a Bean-bound send that holds them.
    const slashTo = parseSlash(el.value)?.agent;
    const stray = (slashTo ? slashTo !== "bean" : isLiveAgent(mode)) ? [] : mappedImageLabels(el.value, imageLabels);
    if (stray.length > 0) {
      const one = stray.length === 1;
      const agent = imageLabels.get(stray[0]!)?.agent;
      setImageError(`${stray.map(imageLabel).join(", ")} ${one ? "was" : "were"} attached for ${agent ? AGENT_NAMES[agent] : "an agent"} — attach ${one ? "it" : "them"} again to show Bean.`);
      return;
    }
    // Image-only sends are allowed; converse still needs some text on the turn.
    const text = el.value.trim() || (pendingImages.length > 0 ? "(image)" : pdf && !pdf.sent && !agentMode ? "(PDF)" : "");
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
    // Image files (and in Bean mode PDFs) become attachments Bean can read; everything else keeps
    // the existing insert-the-path behavior for project/URL drops.
    if (files.length > 0 && files.every((f) => f.type.startsWith("image/") || isPdf(f.type))) {
      e.preventDefault();
      attachFiles(files);
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
      .filter((i) => i.kind === "file" && (i.type.startsWith("image/") || i.type === PDF_MIME))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return; // plain text paste — leave it to the textarea
    e.preventDefault();
    attachFiles(files);
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
  const header = chatHeader({ live, status, model });
  const speaker = (it: ChatItem) => <span class="bean-sr-only">{AGENT_NAMES[itemAgent(it) ?? "bean"]}: </span>;

  return (
    <div class={`bean-chat${terminalOpen ? " bean-chat--term" : ""}`} hidden={hidden}>
      {/* Pinned below the drag band, not inside it — no drag region here. */}
      <div class="bean-chat-meta">
        <AgentAvatar agent={header.agent} size={18} />
        <span class="bean-chat-name">{AGENT_NAMES[header.agent]}</span>
        <span class="bean-chat-status">
          <span class={`bean-chat-state bean-chat-state--${header.status}`} />
          {header.status}
        </span>
        <span class="bean-chat-meta-spacer" />
        {/* The linked-note chip replaces the model id (mockup 1d) — both don't fit. */}
        {linkedNote ? (
          <span class="bean-chat-notechip" title={`Saving from this chat updates "${linkedNote.title}" in place`}>
            <span class="bean-chat-notechip-title">{linkedNote.title}</span> · v{linkedNote.version}
            <button type="button" class="bean-chat-unlink" aria-label="Unlink note" onClick={onUnlink}>✕</button>
          </span>
        ) : (
          <span class="bean-chat-model">{header.model ? modelName(header.model) : ""}</span>
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
        {continueButton}
        <button
          type="button"
          class={`bean-chat-term-toggle${terminalOpen ? " bean-chat-term-toggle--on" : ""}`}
          aria-expanded={terminalOpen}
          aria-label="Terminal"
          title="Terminal (⌃`)"
          onClick={onToggleTerminal}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 10 3 2-3 2" /><path d="M13 15h4" /></svg>
        </button>
      </div>
      <div class="bean-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <PanelEmptyState message="What are we brewing today?">
            <div class="bean-panel-empty-text">Ask Bean to do something, or just say hi.</div>
            <div class="bean-panel-empty-text">⌘-click a link or path to open it</div>
          </PanelEmptyState>
        ) : null}
        {items.map((it, i) => {
          if (it.kind === "user") {
            const bubble = (
              <div key={it.id} class="bean-bubble bean-bubble--user">
                <span class="bean-sr-only">You: </span>
                {it.display ?? it.text}
                {it.pending ? <span class="bean-sr-only"> (not read yet)</span> : null}
                {it.pdf ? <span class="bean-chat-file">📄 {it.pdf.name} · {formatSize(it.pdf.size)}</span> : null}
                {it.images?.map((src) => (
                  <button type="button" class="bean-chat-thumb" title="Preview" onClick={() => setPreview({ dataUrl: src })}>
                    <img src={src} alt="attached image" />
                  </button>
                ))}
              </div>
            );
            // Sent to an agent that hasn't picked it up yet (#746): the outline and caption sit on the
            // page surface, outside the accent fill.
            return it.pending ? (
              <div key={it.id} class="bean-pending">
                {bubble}
                <div class="bean-pending-caption" aria-hidden="true">Not read yet</div>
              </div>
            ) : bubble;
          }
          if (it.kind === "reply") {
            return agentRow(it, i, (
              <div class="bean-bubble bean-bubble--bean">
                {speaker(it)}
                {it.streaming ? <span class="bean-bubble--working">Working<span class="bean-dots"><span /><span /><span /></span></span> : null}
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
              <div class="bean-bubble bean-bubble--bean bean-bubble--working">
                {speaker(it)}{it.text}<span class="bean-dots"><span /><span /><span /></span>
                {stopTarget?.kind === "bean" ? (
                  <>
                    <button type="button" class="bean-status-action" title="Stop this turn (Esc Esc)"
                      disabled={stopTarget.stopping} onClick={onStopTurn}>{stopTarget.stopping ? "Stopping…" : "Stop"}</button>
                    {escHint("bean")}
                  </>
                ) : null}
              </div>
            ));
          }
          if (it.kind === "status") {
            if (it.receipt) {
              return (
                <div key={it.id} class={`bean-status bean-status--${it.tone}`}>
                  {it.text}
                  {!continued && canContinueLive(it, clis, !!live) ? (
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
          if (it.kind === "continued") {
            return (
              <div key={it.id} class="bean-status bean-status--done">
                Continued in Discord · {it.title}{" "}
                <button type="button" class="bean-status-action" onClick={onOpenContinued}>Open thread</button>
              </div>
            );
          }
          if (it.kind === "memory") {
            const facts = it.saved.map((m) => (m.category ? `${m.text} (${m.category})` : m.text)).join("; ");
            return (
              <div key={it.id} class={`bean-status bean-status--${it.state === "undone" ? "info" : "done"}`}>
                {it.state === "undone" ? `Forgot: ${facts}` : `Remembered: ${facts}`}
                {it.state === "undone" || it.state === "kept" ? null : (
                  <button type="button" class="bean-status-action" disabled={it.state === "undoing"} onClick={() => onMemoryUndo(it.id)}>Undo</button>
                )}
              </div>
            );
          }
          if (it.kind === "forgot") {
            const tone = it.state === "error" ? "error" : it.state === "restored" ? "info" : "done";
            return (
              <div key={it.id} class={`bean-status bean-status--${tone} bean-status--forgot`}>
                {it.state === "restored" ? `🧠 Restored — ${it.text}` : `🧠 Forgot — ${it.text}`}
                {it.state === "error" ? ` · Couldn't restore: ${it.error ?? "unknown error"}` : null}
                {it.state === "saved" || it.state === "undoing" || it.state === "error" ? (
                  <button type="button" class="bean-status-action" disabled={it.state === "undoing"} onClick={() => onForgetUndo(it.id)}>Undo</button>
                ) : null}
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
          if (it.kind === "send") {
            return (
              <SendCard
                key={it.id}
                card={it.card}
                state={it.state}
                onSend={(optionId) => onSendConfirm(it.id, optionId)}
                onDismiss={() => onSendDismiss(it.id)}
              />
            );
          }
          if (it.kind === "sprout") {
            return (
              <SproutRunCard
                key={it.id}
                plan={it.plan}
                state={it.state}
                result={it.result}
                onTrigger={() => onSproutTrigger(it.id)}
                onDismiss={() => onSproutDismiss(it.id)}
              />
            );
          }
          if (it.kind === "offer") {
            const launch = offerLaunch(it.offer.projectPath);
            return (
              <LiveOfferCard
                key={it.id}
                offer={it.offer}
                agent={offerAgent(clis)}
                projectName={projectName(launch.projectPath)}
                modelName={launch.model ? modelName(launch.model) : undefined}
                state={it.state}
                onStart={() => onOfferStart(it.id)}
                onDismiss={() => onOfferDismiss(it.id)}
              />
            );
          }
          if (it.kind === "delegate") {
            // Every project, the skill's assigned ones first.
            const skillName = it.proposal.skillName;
            const assignedFirst = skillName
              ? [...projects].sort((a, b) => Number(!!b.skills?.includes(skillName)) - Number(!!a.skills?.includes(skillName)))
              : projects;
            return (
              <DelegateCard
                key={it.id}
                item={it}
                cliOptions={clis}
                delegateCli={delegateCli}
                modelOptions={runModels}
                projectOptions={assignedFirst}
                lastUsedModel={skillName ? lastUsedModels[skillName] : undefined}
                autoFocus={it.id === autoFocusDelegateId}
                onReturnFocus={() => inputRef.current?.focus()}
                browser={skills.find((s) => s.name === skillName)?.browser === true}
                onConfirm={(edited, choice) => onDelegateConfirm(it.id, edited, choice)}
                onDismiss={() => onDelegateDismiss(it.id)}
                onCancelTask={() => onDelegateCancelTask(it.id)}
                onContinueLive={!continued && canContinueLive(it, clis, !!live) ? () => onContinueLive(it.id) : undefined}
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
      {continued ? (
        <div class="bean-chat-continued" role="note">
          <span>This chat continues in Discord — “{continued.title}”. Read only here.</span>
          <button type="button" class="bean-btn" onClick={onOpenContinued}>Open thread</button>
        </div>
      ) : (
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
            <span>{AGENT_NAMES[live.agent]} · {projectName(live.projectPath)}{live.model ? ` · ${modelName(live.model)}` : ""}</span>
            {escHint("live")}
            {live.busy ? (
              <button
                type="button"
                class="bean-status-action"
                title="Stop this turn — session stays open (Esc Esc)"
                disabled={live.stopping}
                onClick={onStopTurn}
              >{live.stopping ? "Stopping…" : "Stop"}</button>
            ) : null}
            <button type="button" class="bean-status-action" onClick={onEndAgent}>End</button>
          </div>
        ) : null}
        {agentMode && incognito ? (
          <div class="bean-status bean-status--info">Off the record covers Bean only — {agentName} keeps its own transcript.</div>
        ) : null}
        {menu?.length ? (
          <div ref={slashMenuRef} class="bean-chip-menu-list bean-slash-menu" role="listbox" aria-label="Commands">
            {menu.map((e, i) => (
              <>
                {e.kind !== menu[i - 1]?.kind ? <div class="bean-chip-menu-hint">{SECTION_TITLES[e.kind]}</div> : null}
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
          </div>
        ) : null}
        {imageError ? <div class="bean-status bean-status--error">{imageError}</div> : null}
        {pdf && !agentMode ? (
          <div class="bean-chat-pending-images">
            <span class="bean-chat-pending-file" title={pdf.sent ? "Bean reads it on every turn until you remove it" : undefined}>
              📄 {pdf.filename} · {formatSize(pdf.size)}
              <button type="button" aria-label={`Remove ${pdf.filename}`} onClick={onRemovePdf}>✕</button>
            </span>
          </div>
        ) : null}
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
            onBlur={disarmEsc}
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
              if (e.key === "Escape" && canStop) {
                if (e.repeat) return;
                if (escArmed) { e.preventDefault(); disarmEsc(); onStopTurn(); return; }
                setEscArmedKey(stopTarget.key);
                clearTimeout(escTimer.current);
                escTimer.current = setTimeout(() => setEscArmedKey(undefined), ESC_STOP_MS);
                return;
              }
              if (escArmed) disarmEsc();
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
              chipLabel={<><AgentAvatar agent={mode} size={16} /> {agentName}{agentMode ? ` · ${projectName(live?.projectPath ?? agentProject)}${chipModel ? ` · ${modelName(chipModel)}` : ""}` : ""}</>}
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
                  {isLiveAgent(mode) ? (
                    <>
                      <div class="bean-chip-menu-divider" />
                      <div class="bean-chip-menu-hint">{live ? "Model · End session to change model" : "Model"}</div>
                      {[{ id: "", label: "Agent default" }, ...agentModels(runModels, mode)].map((m) => (
                        <button
                          type="button"
                          class={`bean-chip-menu-row bean-chip-menu-row--model${m.id === (chipModel ?? "") ? " bean-chip-menu-row--on" : ""}`}
                          disabled={!!live}
                          title={m.id || undefined}
                          onClick={() => { onPickModel(m.id); close(); }}
                        >
                          {m.label}
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
      )}
      <TerminalPane
        mountId={mountId}
        open={terminalOpen}
        projectPath={agentProject}
        projects={projects}
        onOpenChange={onTerminalOpen}
        onShells={onShells}
        shortcutRef={terminalShortcut}
      />
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
