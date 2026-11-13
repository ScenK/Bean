import {
  converse, checkPdfAttachment, launchInTerminal, scratchDir, makeGenerateImageTool, makeMemoryTools, memoryCategories, type ImageGenDeps,
  stageImages, checkImageAttachments, availableModels, pickModel, loadModelMemory, saveModelMemory, planSproutRun, type SproutRunBlock,
  type Project, type RouteSuggestion, type Skill, type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchSpawnFn, type CliName, type Memory, type ActionTool, type NoteDraft, type AvailableModel, type Routine,
  type CliModels, type RoutineBrief, type RoutineWatch, type SendCard,
  DESKTOP_CHAT_MAX_BYTES, type DesktopChat, type DesktopChatInput, type DesktopChatListing,
} from "@bean/core";
import {
  buildConfigHandlers, buildDeleteSkillHandler, buildListProjectsHandler, buildListSkillsHandler, buildMemoryHandlers,
  buildNotesHandlers, buildPersonaHandlers, buildSaveProjectsHandler, buildSaveSkillHandler, toTranscript,
  type buildDestinationHandlers, type buildRoutineHandlers, type buildSendHandlers, type buildSkillProposalHandlers,
  type buildTodoHandlers, type ClientId, type ConfigUpdate, type ConfigView, type MemoryHandlerDeps, type NotesHandlerDeps,
  type ShellOps,
} from "@bean/host";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { IPC, type Theme, type ComponentKind, type DashboardTarget, type ChatDrop, type DroppedImage, type AppInfo, type UpdateStatus, type InstallUpdateResult } from "./channels.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";
import type { createLiveTasks } from "./live-tasks.js";
import { terminalLink, type TerminalTasks } from "./terminal-tasks.js";
import { chatPathTarget, openChatPath } from "./chat-open-path.js";
import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";
import type { UpdateCheckOutcome } from "./updater.js";
import type { buildSyncedChatHandlers } from "./synced-chats.js";
import type { buildDeskContinueHandler } from "./desk-continue.js";
import type { Push } from "./push.js";

const execFileAsync = promisify(execFile);

export { IPC };

// Holds the plan proposed for the (possibly not-yet-loaded) Plan window so its renderer can
// *pull* it on mount via an invoke, instead of racing a pushed `propose-run` message that gets
// silently dropped when it arrives before the renderer subscribes. get() consumes the value so a
// reopened Plan window can't replay a stale proposal. See .memory for the drop-race writeup.
export function buildPlanStore(): { set: (run: RouteSuggestion) => void; get: () => RouteSuggestion | undefined } {
  let pending: RouteSuggestion | undefined;
  return {
    set: (run) => { pending = run; },
    get: () => { const r = pending; pending = undefined; return r; },
  };
}

// Same drop-race fix as buildPlanStore, for a URL dropped on the avatar and routed to chat:
// the push (IPC.componentDroppedUrl) can arrive before a fresh chat window's renderer has
// mounted and subscribed, and gets silently dropped. The renderer pulls this on mount in
// addition to subscribing to the push, so an already-open window still gets the live update.
export function buildDroppedUrlStore(): { set: (drop: ChatDrop) => void; get: () => ChatDrop | undefined } {
  let pending: ChatDrop | undefined;
  return {
    set: (url) => { pending = url; },
    get: () => { const u = pending; pending = undefined; return u; },
  };
}

// A Dashboard target crosses from a renderer (bubble click) or a notification's `meta` — both
// untrusted shapes. Keep only a non-empty routine name and, if present, an ISO `startedAt`; a
// present-but-invalid date rejects the whole target rather than being coerced.
export function parseDashboardTarget(v: unknown): DashboardTarget | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { routine, startedAt } = v as Record<string, unknown>;
  if (typeof routine !== "string" || !routine) return undefined;
  if (startedAt === undefined) return { routine };
  const iso = typeof startedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startedAt) && !Number.isNaN(Date.parse(startedAt));
  return iso ? { routine, startedAt } : undefined;
}

const isDroppedImage = (v: unknown): v is DroppedImage => {
  if (typeof v !== "object" || v === null) return false;
  const { path, mimeType, size, data } = v as Record<string, unknown>;
  // `size` is what the chat guards on, so it must match the bytes actually carried.
  return typeof path === "string" && typeof mimeType === "string" && typeof size === "number" && Number.isSafeInteger(size) && size >= 0
    && (data === undefined || (typeof data === "string" && data.length === Math.ceil(size / 3) * 4));
};

/** `openComponent`'s second argument, by kind: a dropped URL or images only for chat, a run target
 * only for the dashboard; anything else is dropped. */
export function openComponentPayload(kind: ComponentKind, payload: unknown): ChatDrop | DashboardTarget | undefined {
  if (kind === "chat") {
    if (typeof payload === "string") return payload;
    return Array.isArray(payload) && payload.length > 0 && payload.every(isDroppedImage) ? payload : undefined;
  }
  if (kind === "dashboard") return parseDashboardTarget(payload);
  return undefined;
}

/** Where a desktop notification's click lands, from its `meta`: a routine digest opens its run in
 * the Dashboard, a watch alarm the Routines panel, anything else (reminders) Chat. */
export function notificationOpens(meta: Record<string, unknown> | undefined): { kind: ComponentKind; target?: DashboardTarget } {
  if (meta?.open === "routines") return { kind: "routines" };
  if (meta?.open === "dashboard") {
    const target = parseDashboardTarget(meta.target);
    return target ? { kind: "dashboard", target } : { kind: "dashboard" };
  }
  return { kind: "chat" };
}

// A chat-target skill run confirmed in the Plan popup: the composed prompt to auto-send in
// the chat window, plus a short label the transcript shows instead of the full prompt.
// noteSlug present = "Continue in chat" from a note: the chat links to that note (header chip;
// saving defaults to updating it in place).
export interface ChatPromptPayload { prompt: string; label: string; noteSlug?: string; }

// Same drop-race fix as buildPlanStore/buildDroppedUrlStore, for the prompt handed to a chat
// window that may not have mounted yet: pull-on-mount + consume-on-get.
export function buildChatPromptStore(): { set: (p: ChatPromptPayload) => void; get: () => ChatPromptPayload | undefined } {
  let pending: ChatPromptPayload | undefined;
  return {
    set: (p) => { pending = p; },
    get: () => { const p = pending; pending = undefined; return p; },
  };
}

// `text` is the full notice (instruction included) — fed into chat history so a later "retry"
// has context; `display` is the short version actually shown in the chat bubble.
export interface InterruptedRunNotice { text: string; display: string; }

// Same drop-race fix as the stores above, for the "your run was interrupted" notices claimed
// from the outbox at startup (main.ts): the chat window may not be mounted yet when they're
// found, so they're pulled on mount as well as pushed to an already-open window.
export function buildInterruptedRunStore(): {
  set: (notices: InterruptedRunNotice[]) => void;
  get: () => InterruptedRunNotice[] | undefined;
} {
  let pending: InterruptedRunNotice[] | undefined;
  return {
    set: (notices) => { pending = notices; },
    get: () => { const n = pending; pending = undefined; return n; },
  };
}

// Bridges the two-step manual update flow (check-and-download, then a separate confirmed
// install) across two IPC calls. Unlike the drop-race stores above, there's no push/pull
// race here — just a plain slot passing the extracted bundle's path from one invoke to the
// next in the same About-panel session. Not consumed on get: a failed install can be retried
// against the same already-downloaded bundle without re-checking.
export function buildPendingUpdateStore(): { set: (path: string) => void; get: () => string | undefined } {
  let pending: string | undefined;
  return {
    set: (path) => { pending = path; },
    get: () => pending,
  };
}

export interface UpdateHandlerDeps {
  currentVersion: string;
  // Real check/install IO must be unreachable through this handler layer when running as
  // `electron dist/main.js` (no packaged .app) — see .memory and the design spec's dev-build gate.
  isPackaged: boolean;
  checkAndDownloadUpdate: (currentVersion: string) => Promise<UpdateCheckOutcome>;
  installUpdate: (extractedAppPath: string) => Promise<void>;
  pendingUpdateStore: ReturnType<typeof buildPendingUpdateStore>;
  openReleasesPage: () => void;
  // Removes a previously-downloaded, not-yet-installed update's temp dir when a later check
  // supersedes it with a new one — otherwise each repeated "Check for Updates" orphans the
  // prior ~125MB extracted bundle forever. See updater.ts's cleanupExtractedBundle.
  cleanupExtractedBundle: (extractedAppPath: string) => Promise<void>;
}

const DEV_BUILD_MESSAGE = "Updates aren't available in a dev build.";

export function buildUpdateHandlers(deps: UpdateHandlerDeps) {
  return {
    check: async (): Promise<UpdateStatus> => {
      if (!deps.isPackaged) return { status: "error", message: DEV_BUILD_MESSAGE };
      const outcome = await deps.checkAndDownloadUpdate(deps.currentVersion);
      if (outcome.result.status === "available") {
        if (outcome.extractedAppPath) {
          const previous = deps.pendingUpdateStore.get();
          if (previous && previous !== outcome.extractedAppPath) {
            await deps.cleanupExtractedBundle(previous);
          }
          deps.pendingUpdateStore.set(outcome.extractedAppPath);
        }
        return { status: "available", version: outcome.result.version, notes: outcome.result.notes };
      }
      return outcome.result;
    },
    install: async (): Promise<InstallUpdateResult | undefined> => {
      if (!deps.isPackaged) return { status: "error", message: DEV_BUILD_MESSAGE };
      const extractedAppPath = deps.pendingUpdateStore.get();
      if (!extractedAppPath) return { status: "error", message: "No update is ready to install — check for updates again." };
      try {
        await deps.installUpdate(extractedAppPath);
        return undefined; // unreachable in practice: installUpdate exits the process on success
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
    openReleasesPage: (): void => deps.openReleasesPage(),
  };
}

export interface ChatHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  loadMemories: (file: string) => Promise<Memory[]>;
  /** The owner's chatops ids (core `ownerSubjectIds`), so recalled owner-DM facts read as about the user. */
  ownerSubjectIds?: () => Promise<string[]>;
  appendMemories: (file: string, additions: Memory[]) => Promise<void>;
  deleteMemories: (file: string, ids: string[]) => Promise<string[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
  personaFile: string;
  projectPersonaFile: string;
  dbFile: string;
  actions?: ActionTool[];
  delegateAvailable?: () => boolean;
  /** Offer propose_live_session (the hand-off card) to this chat — per request, by sender + mount. */
  liveSessionAvailable?: (clientId: ClientId, mountId: string) => boolean;
  /** Config `webSearch`, read per chat request so a Settings toggle applies without restart. */
  webSearch?: () => boolean;
  /** Its scratch workspace hosts delegates that aren't about a project (main.ts creates it). */
  beanDirPath?: string;
  loadRoutines?: () => Promise<Routine[]>;
  /** A sprout's pending todos and whether its watch is seeded — enables propose_sprout_run. */
  sproutFacts?: (routine: Routine) => Promise<{ pending: number; seeded: boolean }>;
  /** Enables propose_send: matches the spoken destination and keeps the proposal for the Send tap. */
  proposeSend?: (destination: string, body: string) => SendCard;
  /** Enables the generate_image action tool. getModel (not a value): imageModel may live
   * behind runtime config someday; onStart drives the 🎨 working indicator of the chat (mount) that asked. */
  imageGen?: {
    generate: ImageGenDeps["generate"]; getModel: () => string; imagesDir: string; onStart?: (mountId?: string) => void;
    saveNoteImage?: ImageGenDeps["saveNoteImage"];
  };
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  // signal = the turn's Stop (registerIpc's per-mount controller); converse() then resolves `stopped`.
  return async (req: ChatRequest, clientId?: ClientId, mountId?: string, signal?: AbortSignal): Promise<ConverseResult> => {
    // The renderer's imageFileGuard is UX only; main re-checks before anything reaches OpenAI (#733).
    if (req.images !== undefined) checkImageAttachments(req.images);
    // Renderer input is untrusted: a spoofed (non-%PDF-) or oversize document fails the turn here.
    const documents = checkPdfAttachment(req.documents);
    const [skills, projects, persona, memories, routines, ownerIds] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
      deps.loadMemories(deps.dbFile),
      deps.loadRoutines?.() ?? Promise.resolve([] as Routine[]),
      deps.ownerSubjectIds?.() ?? Promise.resolve([]),
    ]);
    const enabled = skills.filter((s) => s.enabled !== false);
    const todoRoutines = routines.filter((r) => r.todoDriven).map((r) => r.name);
    // Per-request (not shared) so `paths` collects only this turn's generated files.
    const imageTool = deps.imageGen
      ? makeGenerateImageTool({
          generate: deps.imageGen.generate,
          model: deps.imageGen.getModel(),
          imagesDir: deps.imageGen.imagesDir,
          onStart: () => deps.imageGen?.onStart?.(mountId),
          saveNoteImage: deps.imageGen.saveNoteImage,
        })
      : undefined;
    // Direct remember/forget only on a turn the user typed — never on a delegate loopback or
    // a composed skill prompt, whose text isn't the user's own words (memory/extract.ts).
    const memoryTools = req.source === "typed" && req.incognito !== true
      ? makeMemoryTools({
          append: (m) => deps.appendMemories(deps.dbFile, m),
          forget: (ids) => deps.deleteMemories(deps.dbFile, ids),
          memories, projects, latestUserText: req.message,
          categorize: true, // the desktop is the owner's own machine (#648)
          classifier: { chat: deps.converse, model: deps.getModel() },
        })
      : undefined;
    const actions = [...(deps.actions ?? []), ...(imageTool ? [imageTool.tool] : []), ...(memoryTools?.tools ?? [])];
    const result = await converse({
      history: req.history,
      latestUserText: req.message,
      latestUserImages: req.images,
      documents,
      skills: enabled,
      projects,
      persona,
      memories,
      ownerIds,
      pinOwnerMemories: true, // the desktop is the owner's own machine (#650)
      ...(memoryTools ? { memoryCategories: memoryCategories(memories) } : {}),
      deps: { chat: deps.converse, model: deps.getModel() },
      droppedUrl: req.droppedUrl,
      actions,
      linkedNote: req.linkedNote,
      delegateAvailable: deps.delegateAvailable?.() ?? false,
      scratchPath: deps.beanDirPath ? scratchDir(deps.beanDirPath) : undefined,
      liveSessionAvailable: clientId !== undefined && mountId !== undefined && (deps.liveSessionAvailable?.(clientId, mountId) ?? false),
      liveSessionHost: "desktop",
      todoRoutines,
      sproutCatalog: deps.sproutFacts ? routines.map((r) => ({ name: r.name, description: r.description })) : [],
      webSearch: deps.webSearch?.() ?? false,
      sendAvailable: deps.proposeSend !== undefined,
      signal,
    });
    if (result.proposedSend && deps.proposeSend) {
      result.sendCard = deps.proposeSend(result.proposedSend.destination, result.proposedSend.text);
      delete result.proposedSend;
    }
    if (result.proposedSproutRun && deps.sproutFacts) await planSproutCard(result, routines, deps.sproutFacts);
    if (imageTool && imageTool.paths.length > 0) {
      result.generatedImages = await Promise.all(imageTool.paths.map(async (path) => ({
        path,
        dataUrl: `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
      })));
    }
    if (memoryTools && memoryTools.remembered.length > 0) result.remembered = memoryTools.remembered;
    if (memoryTools && memoryTools.forgotten.length > 0) result.forgotten = memoryTools.forgotten;
    return result;
  };
}

const SPROUT_BLOCKED: Record<SproutRunBlock, (name: string) => string> = {
  off: (name) => `${name} is off — turn it on in Sprouts.`,
  review: (name) => `${name} needs its first review in Bean's Sprouts panel.`,
  empty: (name) => `${name}'s queue is empty — queue a todo first.`,
};

/** Freezes the run-vs-check decision onto the card, or swaps the card for a fixed reply. */
async function planSproutCard(
  result: ConverseResult, routines: Routine[], facts: NonNullable<ChatHandlerDeps["sproutFacts"]>,
): Promise<void> {
  const name = result.proposedSproutRun!.routine;
  delete result.proposedSproutRun;
  const routine = routines.find((r) => r.name === name);
  if (!routine) return; // converse already refused names outside the catalog
  const { pending, seeded } = await facts(routine);
  const out = planSproutRun(routine, pending, seeded);
  if ("plan" in out) result.sproutRun = out.plan;
  else result.reply = SPROUT_BLOCKED[out.blocked](name);
}

export interface LaunchHandlerDeps {
  spawnLaunch?: LaunchSpawnFn;
  getTerminalApp?: () => string;
  getEditorApp?: () => string;
  onLaunchError?: (req: LaunchRequest, err: Error) => void;
  /** Live Settings-filtered CLIs/models. Optional only for narrow launcher unit seams; main
   * always supplies both, making this the stale-renderer defense boundary. */
  getAvailableClis?: () => CliName[];
  getCliModels?: () => CliModels[];
  // Resolve a "" (no-project) run into a real (bare, always-empty) scratch dir before
  // launchCommand ever sees it. Injectable so tests don't hit the filesystem.
  beanDirPath?: string;
  ensureDir?: (dir: string) => Promise<void>;
}

async function resolveProjectPath(req: LaunchRequest, deps: LaunchHandlerDeps): Promise<string> {
  if (req.projectPath) return req.projectPath;
  const dir = scratchDir(deps.beanDirPath ?? "");
  const ensureDir = deps.ensureDir ?? ((d: string) => mkdir(d, { recursive: true }).then(() => {}));
  await ensureDir(dir);
  return dir;
}

export function buildLaunchHandler(deps: LaunchHandlerDeps) {
  return (req: LaunchRequest): void => {
    const onError = deps.onLaunchError ? (err: Error) => deps.onLaunchError!(req, err) : ((err: Error) => { console.error("bean: launch failed", err); });
    let checked = req;
    if (req.mode !== "open" && deps.getAvailableClis) {
      const enabled = deps.getAvailableClis();
      if (!enabled.includes(req.mode)) {
        onError(new Error(`CLI "${req.mode}" is disabled or unavailable — enable it in Settings.`));
        return;
      }
      if (req.model && deps.getCliModels) {
        checked = {
          ...req,
          model: pickModel(availableModels(deps.getCliModels(), enabled), req.mode, req.model),
        };
      }
    }
    const fire = (resolved: LaunchRequest): void => {
      launchInTerminal(resolved, deps.spawnLaunch, undefined, deps.getTerminalApp?.(), deps.getEditorApp?.(), onError);
    };
    // A real projectPath (or "open" mode, which never uses one) launches synchronously exactly
    // like before this feature — only a "" (no-project) run needs the async scratch-workspace
    // detour, so existing callers/tests see no behavior change.
    if (checked.projectPath || checked.mode === "open") {
      fire(checked);
      return;
    }
    void resolveProjectPath(checked, deps).then(
      (projectPath) => fire({ ...checked, projectPath }),
      (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))),
    );
  };
}

export interface ModelsHandlerDeps {
  getAvailableClis: () => CliName[];
  getCliModels: () => CliModels[];
}

export function buildModelsHandler(deps: ModelsHandlerDeps) {
  return (): AvailableModel[] => availableModels(deps.getCliModels(), deps.getAvailableClis());
}

export interface ModelMemoryHandlerDeps {
  loadModelMemory: (file: string) => Promise<Record<string, string>>;
  saveModelMemory: (file: string, memory: Record<string, string>) => Promise<void>;
  modelMemoryFile: string;
}

export function buildModelMemoryHandlers(deps: ModelMemoryHandlerDeps) {
  // Sets queue on one chain: concurrent load-mutate-saves would otherwise drop each other's keys.
  let writes: Promise<void> = Promise.resolve();
  return {
    get: async (skillName: string): Promise<string | undefined> =>
      (await deps.loadModelMemory(deps.modelMemoryFile))[skillName],
    set: (skillName: string, modelId: string): Promise<void> => {
      const next = writes.then(async () => {
        const memory = await deps.loadModelMemory(deps.modelMemoryFile);
        memory[skillName] = modelId;
        await deps.saveModelMemory(deps.modelMemoryFile, memory);
      });
      writes = next.catch(() => {}); // one failed write mustn't wedge the rest
      return next;
    },
  };
}

/** A chat window's transcript save. `items` are the renderer's normalized ChatItems — opaque here. */
export interface ChatThreadSaveRequest { id: string; title: string; items: unknown[]; noteSlug?: string }
export interface ChatThreadAck { id: string; title: string; updatedAt: string }
/** What a chat restores: a saved thread, or `missing` when the picked one is gone (deleted or
 * pruned) — the chat opens empty with a status row. */
export type PendingChatThread = { id: string; title: string; items: unknown[]; noteSlug: string | null } | { missing: true };

export interface ChatThreadHandlerDeps {
  saveDesktopChat: (file: string, chat: DesktopChatInput, now?: Date) => string;
  getDesktopChat: (file: string, id: string) => DesktopChat | undefined;
  deleteDesktopChat: (file: string, id: string) => void;
  starDesktopChat: (file: string, id: string, starred: boolean) => string | undefined;
  renameDesktopChat: (file: string, id: string, title: string) => string | undefined;
  groupDesktopChats: (file: string, ids: string[], name: string | null) => string[];
  renameDesktopChatGroup: (file: string, from: string, to: string) => string[];
  listDesktopChats: (file: string) => DesktopChatListing[];
  dbFile: string;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Chat sessions ("mounts") inside chat windows. A mount id is a renderer-made UUID attached to
 * exactly one client (push.ts); every per-chat request names it, and main keys that chat's thread
 * pin, incognito latch, memory state and delegate tasks by it — so one window can hold several chats. */
export function buildChatMounts() {
  const mounts = new Map<string, ClientId>(); // mount id → the client it's attached to
  // ponytail: one UUID per chat mount per app run; kept so a released id can't be re-attached, and
  // so a late push for it (a memory receipt, a cancelled task) still reaches the window that held it.
  const released = new Map<string, ClientId>();
  return {
    /** False = refused: not a UUID, already attached, or released. */
    attach: (clientId: ClientId, id: unknown): boolean => {
      if (typeof id !== "string" || !THREAD_ID.test(id) || mounts.has(id) || released.has(id)) return false;
      mounts.set(id, clientId);
      return true;
    },
    /** The state key for a request — throws unless `id` is a mount attached to this client. */
    key: (clientId: ClientId, id: unknown): string => {
      if (typeof id !== "string" || mounts.get(id) !== clientId) throw new Error("unknown chat session");
      return id;
    },
    /** True = it was this client's mount (the caller then drops that chat's state). */
    release: (clientId: ClientId, id: unknown): boolean => {
      if (typeof id !== "string" || mounts.get(id) !== clientId) return false;
      mounts.delete(id);
      released.set(id, clientId);
      return true;
    },
    ofClient: (clientId: ClientId): string[] => [...mounts].flatMap(([id, c]) => (c === clientId ? [id] : [])),
    /** Where a mount-tagged push goes: the client holding the mount, or the one that last held it. */
    clientOf: (id: string): ClientId | undefined => mounts.get(id) ?? released.get(id),
  };
}

/** Desktop chat history (see .memory/project-desktop-chat-history.md). Per chat (mount key): the
 * one thread it writes — pinned by its first save or its restore, and never held by two chats —
 * and the sticky unsavable latch, set on incognito toggle-on *before* the row is deleted and
 * re-checked on every write, the final close write included. Toggling incognito off never clears it. */
export function buildChatThreadHandlers(deps: ChatThreadHandlerDeps) {
  const threads = new Map<string, string>(); // mount key → thread id; dropped at release
  const unsavable = new Set<string>();
  const holder = (id: string): string | undefined => [...threads].find(([, t]) => t === id)?.[0];
  /** A saved thread for this chat to restore (pinned to it), or `missing` when it's gone. */
  const get = (key: string, id: unknown): PendingChatThread => {
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
    const pinned = threads.get(key);
    if (pinned !== undefined && pinned !== id) throw new Error("this chat saves a different chat thread");
    const other = holder(id);
    if (other !== undefined && other !== key) throw new Error("that chat is already open");
    const row = deps.getDesktopChat(deps.dbFile, id);
    if (!row) return { missing: true };
    let items: unknown;
    try { items = JSON.parse(row.itemsJson); } catch { items = []; }
    if (!unsavable.has(key)) threads.set(key, id);
    return { id: row.id, title: row.title, items: Array.isArray(items) ? items : [], noteSlug: row.noteSlug };
  };
  return {
    list: (): DesktopChatListing[] => deps.listDesktopChats(deps.dbFile),
    /** Sidebar delete: never a thread an open chat holds. */
    delete: (id: unknown): void => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      if (holder(id) !== undefined) throw new Error("an open chat can't be deleted");
      deps.deleteDesktopChat(deps.dbFile, id);
    },
    /** Sidebar star: any thread, open or not. The thread's `updatedAt`, or undefined when it's gone. */
    star: (id: unknown, starred: unknown): string | undefined => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      if (typeof starred !== "boolean") throw new Error("starred must be a boolean");
      return deps.starDesktopChat(deps.dbFile, id, starred);
    },
    /** Sidebar rename: any thread, open or not. The stored title, or undefined when it's gone. */
    rename: (id: unknown, title: unknown): string | undefined => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      if (typeof title !== "string") throw new Error("title must be a string");
      return deps.renameDesktopChat(deps.dbFile, id, title);
    },
    /** Sidebar group (stars too) / ungroup (`null`, keeps the star): 1–100 unique UUIDs, open or not.
     * The ids it updated; gone ones are skipped. */
    group: (ids: unknown, name: unknown): string[] => {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new Error("chat thread ids must be 1–100 UUIDs");
      if (!ids.every((id) => typeof id === "string" && THREAD_ID.test(id))) throw new Error("chat thread id must be a UUID");
      if (new Set(ids.map((id: string) => id.toLowerCase())).size !== ids.length) throw new Error("chat thread ids must be unique");
      if (name !== null && typeof name !== "string") throw new Error("group name must be a string or null");
      return deps.groupDesktopChats(deps.dbFile, ids as string[], name);
    },
    /** Sidebar group rename (onto an existing name, they merge): the moved ids. */
    groupRename: (from: unknown, to: unknown): string[] => {
      if (typeof from !== "string" || typeof to !== "string") throw new Error("group names must be strings");
      return deps.renameDesktopChatGroup(deps.dbFile, from, to);
    },
    get,
    /** Undefined = refused by the latch (quietly: the renderer already stopped saving). */
    save: (key: string, req: unknown): ChatThreadAck | undefined => {
      if (unsavable.has(key)) return undefined;
      const o = req as Partial<ChatThreadSaveRequest> | null;
      if (!o || typeof o.id !== "string" || !THREAD_ID.test(o.id)) throw new Error("chat thread id must be a UUID");
      if (typeof o.title !== "string" || !Array.isArray(o.items)) throw new Error("malformed chat thread");
      if (o.noteSlug !== undefined && o.noteSlug !== null && typeof o.noteSlug !== "string") throw new Error("malformed chat thread");
      const pinned = threads.get(key);
      if (pinned !== undefined && pinned !== o.id) throw new Error("this chat saves a different chat thread");
      const other = holder(o.id);
      if (other !== undefined && other !== key) throw new Error("another open chat saves this thread");
      const itemsJson = JSON.stringify(o.items);
      if (Buffer.byteLength(itemsJson, "utf8") > DESKTOP_CHAT_MAX_BYTES) throw new Error("desktop chat is too large to save");
      const now = new Date();
      // The stored title, not the renderer's: a rename since the first save wins over the open chat's copy.
      const title = deps.saveDesktopChat(deps.dbFile, { id: o.id, title: o.title, itemsJson, noteSlug: o.noteSlug ?? null }, now);
      threads.set(key, o.id);
      return { id: o.id, title, updatedAt: now.toISOString() };
    },
    /** 🕶 on: latch first, then delete the chat's saved row. Off: nothing — the latch is sticky. */
    setIncognito: (key: string, on: boolean): void => {
      if (!on) return;
      unsavable.add(key);
      const id = threads.get(key);
      if (id !== undefined) deps.deleteDesktopChat(deps.dbFile, id);
    },
    /** The chat mount is gone: its thread is free to delete or reopen. */
    release: (key: string): void => {
      threads.delete(key);
      unsavable.delete(key);
    },
  };
}

export interface ThemeHandlerDeps {
  getCurrentTheme: () => Theme;
  setCurrentTheme: (theme: Theme) => Promise<void>;
}

export function buildThemeHandlers(deps: ThemeHandlerDeps) {
  return {
    get: (): Theme => deps.getCurrentTheme(),
    set: async (theme: Theme): Promise<void> => { await deps.setCurrentTheme(theme); },
  };
}

export interface ChatopsHandlerDeps {
  chatopsStatus: () => Record<ChatopsBot, ChatopsState>;
  chatopsStart: (bot: ChatopsBot) => void;
  chatopsStop: (bot: ChatopsBot) => void;
}

export function buildChatopsHandlers(deps: ChatopsHandlerDeps) {
  return {
    status: (): Record<ChatopsBot, ChatopsState> => deps.chatopsStatus(),
    start: (bot: ChatopsBot): void => deps.chatopsStart(bot),
    stop: (bot: ChatopsBot): void => deps.chatopsStop(bot),
  };
}

export interface RegisterDeps extends ThemeHandlerDeps, ChatopsHandlerDeps, UpdateHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  deleteSkill: (dir: string, name: string) => Promise<void>;
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
  loadMemories: (file: string) => Promise<Memory[]>;
  ownerSubjectIds?: ChatHandlerDeps["ownerSubjectIds"];
  appendMemories: MemoryHandlerDeps["appendMemories"];
  updateMemory: MemoryHandlerDeps["updateMemory"];
  updateMemoryCategory: MemoryHandlerDeps["updateMemoryCategory"];
  renameMemoryCategory: MemoryHandlerDeps["renameMemoryCategory"];
  deleteMemories: MemoryHandlerDeps["deleteMemories"];
  extractMemories: MemoryHandlerDeps["extractMemories"];
  autoMemory: MemoryHandlerDeps["autoMemory"];
  onMemoryBatch?: MemoryHandlerDeps["onMemoryBatch"];
  onMemoryFailure?: MemoryHandlerDeps["onMemoryFailure"];
  onTurnBatch?: MemoryHandlerDeps["onTurnBatch"];
  getLastDream: MemoryHandlerDeps["getLastDream"];
  restoreDreamRun: MemoryHandlerDeps["restoreDreamRun"];
  dreamDetails: MemoryHandlerDeps["dreamDetails"];
  loadNotes: NotesHandlerDeps["loadNotes"];
  saveNote: NotesHandlerDeps["saveNote"];
  archiveNote: NotesHandlerDeps["archiveNote"];
  restoreNote: NotesHandlerDeps["restoreNote"];
  purgeNote: NotesHandlerDeps["purgeNote"];
  starNote: NotesHandlerDeps["starNote"];
  loadNoteHistory: NotesHandlerDeps["loadNoteHistory"];
  saveNoteImage: NotesHandlerDeps["saveNoteImage"];
  loadNoteImage: NotesHandlerDeps["loadNoteImage"];
  dbFile: string;
  actions?: ActionTool[];
  delegateAvailable?: () => boolean;
  liveSessionAvailable?: ChatHandlerDeps["liveSessionAvailable"];
  webSearch?: () => boolean;
  imageGen?: ChatHandlerDeps["imageGen"];
  sproutFacts?: ChatHandlerDeps["sproutFacts"];
  proposeSend?: ChatHandlerDeps["proposeSend"];
  sendHandlers?: ReturnType<typeof buildSendHandlers>;
  push: Push;
  /** Dialogs, Finder, the browser and window sizing — Electron, injected (app/src/shell-ops.ts). */
  shell: ShellOps;
  openComponent: (kind: ComponentKind, payload?: ChatDrop | DashboardTarget) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  getPendingPlan: () => RouteSuggestion | undefined;
  getPendingDroppedUrl: () => ChatDrop | undefined;
  getPendingDashboardTarget: () => DashboardTarget | undefined;
  runInChat: (payload: ChatPromptPayload) => void;
  getPendingChatPrompt: () => ChatPromptPayload | undefined;
  getPendingInterruptedRunNotices: () => InterruptedRunNotice[] | undefined;
  planFromDrop: (skillName: string, droppedUrl: string) => void;
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  getAppInfo: () => AppInfo;
  spawnLaunch?: LaunchSpawnFn;
  getTerminalApp: () => string;
  getEditorApp: () => string;
  getAvailableClis: () => CliName[];
  getDetectedClis: () => CliName[];
  getCliModels: () => CliModels[];
  beanDirPath: string;
  modelMemoryFile: string;
  delegateTasks: {
    start: (req: DelegateStartRequest) => Promise<string>;
    cancel: (taskId: string) => void;
    /** Stops every task one chat (mount) started — its release. */
    cancelMount: (mountId: string) => void;
  };
  liveTasks: Pick<ReturnType<typeof createLiveTasks>, "start" | "send" | "stop" | "interrupt" | "resume" | "stopMount" | "projectOf">;
  terminalTasks: Pick<TerminalTasks, "start" | "write" | "resize" | "ack" | "stop" | "stopMount" | "runningCommand">;
  /** Whether a client is the chat window — the only window that may drive an agent session. */
  isChatClient: (clientId: ClientId) => boolean;
  onLaunchError?: (req: LaunchRequest, err: Error) => void;
  /** Called as a chat (mount) turn starts; the returned fn is called when it ends (with the failure, if any). */
  onChatTurn?: (mountId: string) => (error?: string) => void;
  loadRoutines?: () => Promise<Routine[]>;
  routineHandlers: ReturnType<typeof buildRoutineHandlers>;
  skillProposalHandlers: ReturnType<typeof buildSkillProposalHandlers>;
  todoHandlers: ReturnType<typeof buildTodoHandlers>;
  chatThreadHandlers: ReturnType<typeof buildChatThreadHandlers>;
  syncedChatHandlers: ReturnType<typeof buildSyncedChatHandlers>;
  destinationHandlers: ReturnType<typeof buildDestinationHandlers>;
  /** Continue in Discord; absent = not offered (refused). */
  deskContinue?: ReturnType<typeof buildDeskContinueHandler>;
}

/** `releaseChatClient` = a chat window is gone: release every chat it still had attached.
 * `clientOfMount` = where a mount-tagged push goes (push.ts). */
export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): {
  releaseChatClient: (clientId: ClientId) => void;
  clientOfMount: (mountId: string) => ClientId | undefined;
} {
  const chatHandler = buildChatHandler(deps);
  const memoryHandlers = buildMemoryHandlers(deps);
  // Every per-chat request names its chat's mount id (see buildChatMounts). Refused unless it comes
  // from the chat window and that mount is attached to it.
  const mounts = buildChatMounts();
  const chatKey = (client: ClientId, mountId: unknown): string => {
    if (!deps.isChatClient(client)) throw new Error("Chats run in the chat window.");
    return mounts.key(client, mountId);
  };
  // For fire-and-forget channels: a refused request is dropped, never thrown into the void.
  const tryChatKey = (client: ClientId, mountId: unknown): string | undefined => {
    try { return chatKey(client, mountId); } catch { return undefined; }
  };
  // Bean's running turn per chat (mount key), so Stop / Esc Esc and a release can abort it.
  const beanTurns = new Map<string, { turnId: unknown; ctl: AbortController }>();
  const releaseChat = (clientId: ClientId, mountId: string): void => {
    if (!mounts.release(clientId, mountId)) return;
    beanTurns.get(mountId)?.ctl.abort();
    memoryHandlers.release(mountId);
    deps.chatThreadHandlers.release(mountId);
    deps.delegateTasks.cancelMount(mountId);
    deps.liveTasks.stopMount(mountId);
    void deps.terminalTasks.stopMount(mountId); // never rejects; the entry is held until the shell is gone
  };
  ipcMain.on(IPC.chatAttach, (e, mountId: unknown) => {
    if (deps.isChatClient(e.sender.id) && !mounts.attach(e.sender.id, mountId)) console.error("chat attach refused");
  });
  ipcMain.on(IPC.chatRelease, (e, mountId: unknown) => {
    if (typeof mountId === "string") releaseChat(e.sender.id, mountId);
  });
  ipcMain.handle(IPC.chat, async (e, req: ChatRequest, mountId: unknown) => {
    const key = chatKey(e.sender.id, mountId);
    // Registered before any await, so a Stop that lands while the loaders run still aborts.
    const turn = { turnId: req?.turnId, ctl: new AbortController() };
    beanTurns.set(key, turn);
    const end = deps.onChatTurn?.(key);
    try {
      const result = await chatHandler(req, e.sender.id, key, turn.ctl.signal);
      end?.(result.error);
      // Stopped by the user: no error bubble, and nothing of this turn is captured as memory.
      if (result.stopped) return result;
      // Fire-and-forget, off the reply path: the reply returns now, the receipt row follows —
      // tagged with its chat, which may no longer be the visible one.
      memoryHandlers.captureTurn(key, req, result).then((batch) => {
        if (batch.length > 0) {
          deps.push.send(key, IPC.memoryUpdated, { saved: batch.map(({ id, text, category }) => ({ id, text, category })), mountId: key });
        }
      }).catch((err) => console.error("per-turn memory capture failed:", err));
      return result;
    } catch (err) {
      end?.(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (beanTurns.get(key) === turn) beanTurns.delete(key);
    }
  });
  // Only the running turn it names: a late Stop must not abort the next turn.
  ipcMain.on(IPC.chatStop, (e, mountId: unknown, turnId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    const turn = key === undefined ? undefined : beanTurns.get(key);
    if (turn && typeof turnId === "string" && turn.turnId === turnId) turn.ctl.abort();
  });
  // Agent-mode images: a paste or browser drag has no file on disk, so it's written to a private
  // temp dir (one per app run) and the agent reads it by path. stageImages checks mime + size.
  let stageDir: Promise<string> | undefined;
  ipcMain.handle(IPC.chatStageImage, async (e, data: unknown, mime: unknown, mountId: unknown) => {
    chatKey(e.sender.id, mountId);
    if (typeof data !== "string" || typeof mime !== "string") throw new Error("malformed image");
    stageDir ??= mkdtemp(join(tmpdir(), "bean-images-")).catch((err: unknown) => { stageDir = undefined; throw err; });
    const [path] = await stageImages([{ data, mimeType: mime }], await stageDir);
    return path;
  });
  ipcMain.handle(IPC.getModel, () => deps.getModel());

  const listSkillsHandler = buildListSkillsHandler(deps);
  ipcMain.handle(IPC.listSkills, () => listSkillsHandler());

  const listProjectsHandler = buildListProjectsHandler(deps);
  ipcMain.handle(IPC.listProjects, () => listProjectsHandler());

  const saveProjectsHandler = buildSaveProjectsHandler(deps);
  ipcMain.handle(IPC.saveProjects, (_e, projects: Project[]) => saveProjectsHandler(projects));

  // Native pickers (Settings' Terminal/Editor App fields, "add project") and Finder reveal.
  ipcMain.handle(IPC.pickProjectFolder, (e) => deps.shell.pickFolder(e.sender.id));
  ipcMain.handle(IPC.pickTerminalApp, (e) => deps.shell.pickApp(e.sender.id));
  ipcMain.handle(IPC.pickEditorApp, (e) => deps.shell.pickApp(e.sender.id));
  ipcMain.on(IPC.revealInFinder, (_e, path: string) => deps.shell.reveal(path));

  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const deleteSkillHandler = buildDeleteSkillHandler(deps);
  ipcMain.handle(IPC.deleteSkill, (_e, name: string) => deleteSkillHandler(name));

  const launchHandler = buildLaunchHandler(deps);
  ipcMain.on(IPC.launch, (_e, req: LaunchRequest) => launchHandler(req));
  ipcMain.handle(IPC.delegateStart, (e, req: DelegateStartRequest, mountId: unknown) => {
    const key = chatKey(e.sender.id, mountId);
    return deps.delegateTasks.start({ ...req, offRecord: memoryHandlers.isIncognito(key), mountId: key });
  });
  ipcMain.on(IPC.delegateCancel, (_e, taskId: string) => deps.delegateTasks.cancel(taskId));
  // Sessions belong to one chat (sender + attached mount); every payload is validated in live-tasks.
  const liveOwner = (client: ClientId, mountId: unknown) => {
    const key = tryChatKey(client, mountId);
    return key === undefined ? undefined : { clientId: client, mountId: key };
  };
  const notLive = "Agent sessions run from the chat window.";
  ipcMain.handle(IPC.liveStart, (e, req: unknown, mountId: unknown) => {
    const o = liveOwner(e.sender.id, mountId);
    return o ? deps.liveTasks.start(o, req) : { error: notLive };
  });
  ipcMain.handle(IPC.liveSend, (e, sessionId: unknown, text: unknown, mountId: unknown) => {
    const o = liveOwner(e.sender.id, mountId);
    return o ? deps.liveTasks.send(o, sessionId, text) : notLive;
  });
  ipcMain.on(IPC.liveStop, (e, sessionId: unknown, mountId: unknown) => {
    const o = liveOwner(e.sender.id, mountId);
    if (o) deps.liveTasks.stop(o, sessionId);
  });
  ipcMain.handle(IPC.liveInterrupt, (e, sessionId: unknown, mountId: unknown, turns: unknown) => {
    const o = liveOwner(e.sender.id, mountId);
    return o ? deps.liveTasks.interrupt(o, sessionId, turns) : false;
  });
  ipcMain.handle(IPC.liveResume, (e, sessionId: unknown, mountId: unknown) => {
    const o = liveOwner(e.sender.id, mountId);
    return o ? deps.liveTasks.resume(o, sessionId) : { error: notLive };
  });
  // A chat's terminals: every call names an attached mount of the chat window, plus the tab;
  // payloads and tab ids are validated in terminal-tasks. Refused fire-and-forget calls are dropped.
  ipcMain.handle(IPC.terminalStart, (e, projectPath: unknown, cols: unknown, rows: unknown, mountId: unknown, tabId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    return key === undefined
      ? { error: "Terminals run from the chat window." }
      : deps.terminalTasks.start({ clientId: e.sender.id, mountId: key }, tabId, projectPath, cols, rows);
  });
  ipcMain.on(IPC.terminalWrite, (e, data: unknown, mountId: unknown, tabId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.write(key, tabId, data);
  });
  ipcMain.on(IPC.terminalResize, (e, cols: unknown, rows: unknown, mountId: unknown, tabId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.resize(key, tabId, cols, rows);
  });
  ipcMain.on(IPC.terminalAck, (e, chars: unknown, mountId: unknown, tabId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.ack(key, tabId, chars);
  });
  // No tab = every tab of the chat.
  ipcMain.handle(IPC.terminalStop, async (e, mountId: unknown, tabId?: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    if (key === undefined) return;
    await (tabId === undefined ? deps.terminalTasks.stopMount(key) : deps.terminalTasks.stop(key, tabId));
  });
  // The close cards' fresh check: what runs in this chat's terminals (or one tab's) right now.
  ipcMain.handle(IPC.terminalRunning, (e, mountId: unknown, tabId?: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    return key === undefined ? [] : deps.terminalTasks.runningCommand(key, tabId);
  });
  ipcMain.on(IPC.terminalOpenLink, (e, url: unknown, mountId: unknown) => {
    const href = tryChatKey(e.sender.id, mountId) === undefined ? undefined : terminalLink(url);
    if (href) deps.shell.openExternal(href).catch((err: unknown) => console.error("terminal link failed:", err));
  });
  // Cmd+click on a path in the chat log (#779): validated and resolved here, never by the renderer.
  ipcMain.on(IPC.chatOpenPath, (e, raw: unknown, mountId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    const abs = key === undefined ? undefined : chatPathTarget(raw, deps.liveTasks.projectOf(key), homedir());
    if (!abs) return;
    void openChatPath(abs, {
      realpath,
      stat,
      editorApp: deps.getEditorApp(),
      terminalApp: deps.getTerminalApp(),
      openDir: deps.shell.openPath,
      reveal: deps.shell.reveal,
      openInEditor: (app, p) => execFileAsync("/usr/bin/open", ["-a", app, p]),
    });
  });
  ipcMain.handle(IPC.availableClis, () => deps.getAvailableClis());
  ipcMain.handle(IPC.detectedClis, () => deps.getDetectedClis());

  const modelsHandler = buildModelsHandler(deps);
  ipcMain.handle(IPC.availableModels, () => modelsHandler());

  const modelMemoryHandlers = buildModelMemoryHandlers({
    loadModelMemory, saveModelMemory, modelMemoryFile: deps.modelMemoryFile,
  });
  ipcMain.handle(IPC.getModelMemory, (_e, skillName: string) => modelMemoryHandlers.get(skillName));
  ipcMain.handle(IPC.setModelMemory, (_e, skillName: string, modelId: string) => modelMemoryHandlers.set(skillName, modelId));

  const personaHandlers = buildPersonaHandlers(deps);
  ipcMain.handle(IPC.getPersona, () => personaHandlers.get());
  ipcMain.handle(IPC.savePersona, (_e, p: Persona) => personaHandlers.save(p));

  ipcMain.handle(IPC.listMemories, () => memoryHandlers.list());
  ipcMain.handle(IPC.appendMemories, (_e, additions: Memory[]) => memoryHandlers.append(additions));
  ipcMain.handle(IPC.updateMemory, (_e, id: string, text: string) => memoryHandlers.update(id, text));
  ipcMain.handle(IPC.deleteMemories, (_e, ids: string[]) => memoryHandlers.delete(ids));
  ipcMain.handle(IPC.updateMemoryCategory, (_e, id: string, category: string | null) => memoryHandlers.updateCategory(id, category));
  ipcMain.handle(IPC.renameMemoryCategory, (_e, from: string, to: string) => memoryHandlers.renameCategory(from, to));
  ipcMain.handle(IPC.memoryOwnerIds, () => memoryHandlers.ownerIds());
  // Fire-and-forget: the chat window is already closing. A failure already raised its bubble
  // (onMemoryFailure); this only logs it.
  ipcMain.on(IPC.chatIncognito, (e, on: unknown, mountId: unknown) => {
    const key = tryChatKey(e.sender.id, mountId);
    if (key === undefined) return;
    memoryHandlers.setIncognito(key, on === true);
    try { deps.chatThreadHandlers.setIncognito(key, on === true); } catch (err) { console.error("chat history delete failed:", err); }
  });
  const notChat = (): never => { throw new Error("Chat history is for the chat window."); };
  ipcMain.handle(IPC.chatThreadSave, (e, req: unknown, mountId: unknown) =>
    deps.chatThreadHandlers.save(chatKey(e.sender.id, mountId), req));
  ipcMain.handle(IPC.chatThreadGet, (e, id: unknown, mountId: unknown) =>
    deps.chatThreadHandlers.get(chatKey(e.sender.id, mountId), id));
  ipcMain.handle(IPC.chatThreadList, (e) => deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.list() : notChat());
  ipcMain.handle(IPC.chatThreadDelete, (e, id: unknown) =>
    deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.delete(id) : notChat());
  ipcMain.handle(IPC.chatThreadStar, (e, id: unknown, starred: unknown) =>
    deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.star(id, starred) : notChat());
  ipcMain.handle(IPC.chatThreadRename, (e, id: unknown, title: unknown) =>
    deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.rename(id, title) : notChat());
  ipcMain.handle(IPC.chatThreadGroup, (e, ids: unknown, name: unknown) =>
    deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.group(ids, name) : notChat());
  ipcMain.handle(IPC.chatThreadGroupRename, (e, from: unknown, to: unknown) =>
    deps.isChatClient(e.sender.id) ? deps.chatThreadHandlers.groupRename(from, to) : notChat());
  ipcMain.handle(IPC.syncedChatList, (e) => deps.isChatClient(e.sender.id) ? deps.syncedChatHandlers.list() : notChat());
  ipcMain.handle(IPC.syncedChatGet, (e, surface: unknown, conversationId: unknown, mountId: unknown) => {
    chatKey(e.sender.id, mountId);
    return deps.syncedChatHandlers.get(surface, conversationId);
  });
  ipcMain.handle(IPC.syncedChatSend, (e, surface: unknown, conversationId: unknown, text: unknown, mountId: unknown) => {
    chatKey(e.sender.id, mountId);
    return deps.syncedChatHandlers.send(surface, conversationId, text);
  });
  ipcMain.handle(IPC.syncedChatResume, (e, surface: unknown, conversationId: unknown, mountId: unknown) => {
    chatKey(e.sender.id, mountId);
    return deps.syncedChatHandlers.resume(surface, conversationId);
  });
  // Continue in Discord: one chat (sender + attached mount), its incognito latch read here, not sent.
  ipcMain.handle(IPC.deskContinue, (e, req: unknown, mountId: unknown) => {
    const key = chatKey(e.sender.id, mountId);
    if (!deps.deskContinue) return { failed: "Continue in Discord isn't available." };
    return deps.deskContinue({ clientId: e.sender.id, mountId: key }, memoryHandlers.isIncognito(key), req);
  });
  ipcMain.on(IPC.rememberOnClose, (e, transcript: unknown, opts: unknown) => {
    const o = opts as { incognito?: unknown; rejected?: unknown; mountId?: unknown } | null;
    const key = tryChatKey(e.sender.id, o?.mountId);
    if (key === undefined) return;
    const incognito = o?.incognito === true;
    const rejected = Array.isArray(o?.rejected) ? o.rejected.filter((t): t is string => typeof t === "string") : [];
    memoryHandlers.rememberOnClose(toTranscript(transcript), { incognito, rejected, key }).catch((err) => {
      console.error("auto-remember failed:", err);
    });
  });
  ipcMain.handle(IPC.getMemoryBatch, () => memoryHandlers.batch());
  ipcMain.handle(IPC.undoMemoryBatch, () => memoryHandlers.undoBatch());
  ipcMain.handle(IPC.getLastDream, () => memoryHandlers.lastDream());
  ipcMain.handle(IPC.undoLastDream, () => memoryHandlers.undoLastDream());
  ipcMain.handle(IPC.dreamDetails, () => memoryHandlers.dreamDetails());

  const notesHandlers = buildNotesHandlers(deps);
  ipcMain.handle(IPC.listNotes, (_e, opts?: unknown) => notesHandlers.list(opts));
  ipcMain.handle(IPC.saveNote, (_e, draft: NoteDraft, images?: unknown) => notesHandlers.save(draft, images));
  ipcMain.handle(IPC.saveNoteImage, (_e, bytes: unknown) => notesHandlers.saveImage(bytes));
  ipcMain.handle(IPC.noteImage, (_e, id: unknown) => notesHandlers.image(id));
  ipcMain.handle(IPC.archiveNote, (_e, slug: unknown) => notesHandlers.archive(slug));
  ipcMain.handle(IPC.restoreNote, (_e, slug: unknown) => notesHandlers.restore(slug));
  ipcMain.handle(IPC.purgeNote, (_e, slug: unknown) => notesHandlers.purge(slug));
  // === true, not a cast: the renderer's types are erased by the time a value crosses IPC,
  // and every truthy payload ("false" included) would otherwise star the note.
  ipcMain.handle(IPC.starNote, (_e, slug: string, starred: unknown) => notesHandlers.star(slug, starred === true));
  ipcMain.handle(IPC.noteHistory, (_e, slug: string) => notesHandlers.history(slug));

  const configHandlers = buildConfigHandlers({
    getConfig: deps.getConfig,
    applyConfig: deps.applyConfig,
    onApplied: () => deps.push.broadcast(IPC.cliAvailabilityChanged, undefined),
  });
  ipcMain.handle(IPC.getConfig, () => configHandlers.get());
  ipcMain.handle(IPC.saveConfig, (_e, update: ConfigUpdate) => configHandlers.save(update));
  ipcMain.handle(IPC.getAppInfo, () => deps.getAppInfo());

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.push.broadcast(IPC.themeChanged, next);
  });

  const chatopsHandlers = buildChatopsHandlers(deps);
  ipcMain.handle(IPC.chatopsStatus, () => chatopsHandlers.status());
  ipcMain.on(IPC.chatopsStart, (_e, bot: ChatopsBot) => chatopsHandlers.start(bot));
  ipcMain.on(IPC.chatopsStop, (_e, bot: ChatopsBot) => chatopsHandlers.stop(bot));
  ipcMain.handle(IPC.destinationsList, () => deps.destinationHandlers.list());
  ipcMain.handle(IPC.destinationsName, (_e, surface: unknown, conversationId: unknown, alias: unknown) =>
    deps.destinationHandlers.name(surface, conversationId, alias));
  ipcMain.handle(IPC.destinationsClear, (_e, surface: unknown, conversationId: unknown) =>
    deps.destinationHandlers.clear(surface, conversationId));
  ipcMain.handle(IPC.destinationsNameRaw, (_e, surface: unknown, conversationId: unknown, alias: unknown) =>
    deps.destinationHandlers.nameRaw(surface, conversationId, alias));
  ipcMain.handle(IPC.sendToDestination, (e, proposalId: unknown, optionId: unknown) => {
    if (!deps.isChatClient(e.sender.id) || !deps.sendHandlers) throw new Error("Sends are confirmed in the chat window.");
    return deps.sendHandlers.send(proposalId, optionId);
  });
  ipcMain.handle(IPC.destinationsRetarget, (_e, alias: unknown, surface: unknown, conversationId: unknown) =>
    deps.destinationHandlers.retarget(alias, surface, conversationId));

  const updateHandlers = buildUpdateHandlers(deps);
  ipcMain.handle(IPC.checkForUpdate, () => updateHandlers.check());
  ipcMain.handle(IPC.installUpdate, () => updateHandlers.install());
  ipcMain.on(IPC.openUpdateReleasePage, () => updateHandlers.openReleasesPage());

  ipcMain.handle(IPC.skillProposalsList, () => deps.skillProposalHandlers.list());
  ipcMain.handle(IPC.skillProposalsApprove, (_e, id: string) => deps.skillProposalHandlers.approve(id));
  ipcMain.handle(IPC.skillProposalsReject, (_e, id: string) => deps.skillProposalHandlers.reject(id));
  ipcMain.handle(IPC.skillProposalsUndo, (_e, id: string) => deps.skillProposalHandlers.undo(id));
  ipcMain.handle(IPC.routinesList, () => deps.routineHandlers.list());
  ipcMain.handle(IPC.routinesSave, (_e, routine: Routine) => deps.routineHandlers.save(routine));
  ipcMain.handle(IPC.routinesDelete, (_e, name: string) => deps.routineHandlers.remove(name));
  ipcMain.handle(IPC.routinesState, () => deps.routineHandlers.state());
  ipcMain.handle(IPC.routinesRunNow, (_e, name: string) => deps.routineHandlers.runNow(name));
  ipcMain.handle(IPC.routineStop, (_e, name: unknown) => deps.routineHandlers.stop(name));
  ipcMain.handle(IPC.routinesAttempts, (_e, runId: string) => deps.routineHandlers.attempts(runId));
  ipcMain.handle(IPC.routinesCheckNow, (_e, name: string) => deps.routineHandlers.checkNow(name));
  ipcMain.handle(IPC.routinesPreviewWatch, (_e, w: RoutineWatch) => deps.routineHandlers.previewWatch(w));
  ipcMain.handle(IPC.routinesEnableWatch, (_e, name: string, queueExisting: boolean) => deps.routineHandlers.enableWatch(name, queueExisting));
  ipcMain.handle(IPC.routinesSinkRecipients, () => deps.routineHandlers.sinkRecipients());
  ipcMain.handle(IPC.routinesDraftBrief, (_e, sentence: string, previous?: RoutineBrief) => deps.routineHandlers.draftBrief(sentence, previous));
  ipcMain.handle(IPC.routinesBuild, (_e, brief: RoutineBrief) => deps.routineHandlers.build(brief));
  ipcMain.handle(IPC.routinesBuilds, () => deps.routineHandlers.builds());
  ipcMain.handle(IPC.routinesCancelBuild, (_e, name: string) => deps.routineHandlers.cancelBuild(name));
  ipcMain.handle(IPC.routinesDismissBuild, (_e, name: string) => deps.routineHandlers.dismissBuild(name));

  ipcMain.handle(IPC.todosList, (_e, routine: string) => deps.todoHandlers.list(routine));
  ipcMain.handle(IPC.todosListAll, () => deps.todoHandlers.listAll());
  ipcMain.handle(IPC.todosAdd, (_e, routine: string, text: string) => deps.todoHandlers.add(routine, text));
  ipcMain.handle(IPC.todosEdit, (_e, id: string, text: string) => deps.todoHandlers.edit(id, text));
  ipcMain.handle(IPC.todosDelete, (_e, id: string) => deps.todoHandlers.remove(id));
  ipcMain.handle(IPC.todosReorder, (_e, id: string, newOrder: number) => deps.todoHandlers.reorder(id, newOrder));
  ipcMain.handle(IPC.todosClearFinished, (_e, routine: string) => deps.todoHandlers.clearFinished(routine));
  ipcMain.handle(IPC.todosRetry, (_e, id: string) => deps.todoHandlers.retry(id));

  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, payload?: unknown) => deps.openComponent(kind, openComponentPayload(kind, payload)));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
  ipcMain.handle(IPC.getPendingPlan, () => deps.getPendingPlan());
  ipcMain.handle(IPC.getPendingDroppedUrl, () => deps.getPendingDroppedUrl());
  ipcMain.handle(IPC.getPendingDashboardTarget, () => deps.getPendingDashboardTarget());
  ipcMain.on(IPC.planFromDrop, (_e, skillName: string, droppedUrl: string) => deps.planFromDrop(skillName, droppedUrl));
  ipcMain.on(IPC.runInChat, (_e, payload: ChatPromptPayload) => deps.runInChat(payload));
  ipcMain.handle(IPC.getPendingChatPrompt, () => deps.getPendingChatPrompt());
  ipcMain.handle(IPC.getPendingInterruptedRunNotices, () => deps.getPendingInterruptedRunNotices());

  // Lets a component window grow to fit its own content (e.g. About growing when an update
  // notice appears) instead of clipping it.
  ipcMain.on(IPC.resizeWindowToContent, (e, height: number) => deps.shell.fitHeight(e.sender.id, height));

  return {
    releaseChatClient: (clientId) => { for (const id of mounts.ofClient(clientId)) releaseChat(clientId, id); },
    clientOfMount: mounts.clientOf,
  };
}
