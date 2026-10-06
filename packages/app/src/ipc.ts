import {
  route, converse, launchInTerminal, scratchDir, makeGenerateImageTool, makeMemoryTools, type ImageGenDeps,
  attachNoteImages, MAX_NOTE_IMAGE_BYTES, type ImageAttachment,
  availableModels, pickModel, loadModelMemory, saveModelMemory, resolveTodoRoutine,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchSpawnFn, type CliName, type Memory, type MemoryCandidate, type ChatTurn,
  type ActionTool, type Note, type NoteDraft, type AvailableModel, type Routine, type RoutineState, type RunRecord,
  type TodoItem, type CliModels, type DreamDigest, type RoutineBrief, type RoutineWatch, type WatchItem,
} from "@bean/core";
import type { RoutineBuildView } from "./routine-builder.js";
import type { WatchCheckResult } from "./routine-scheduler.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { RouterDeps } from "@bean/core";
import { BrowserWindow, dialog, screen, shell, type IpcMain } from "electron";
import { IPC, type Theme, type ComponentKind, type ConfigView, type ConfigUpdate, type AppInfo, type UpdateStatus, type InstallUpdateResult } from "./channels.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";
import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";
import type { UpdateCheckOutcome } from "./updater.js";

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
export function buildDroppedUrlStore(): { set: (url: string) => void; get: () => string | undefined } {
  let pending: string | undefined;
  return {
    set: (url) => { pending = url; },
    get: () => { const u = pending; pending = undefined; return u; },
  };
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

export interface RouteHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  chat: RouterDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
}

export function buildRouteHandler(deps: RouteHandlerDeps) {
  return async (input: RouteInput): Promise<RouteSuggestion> => {
    const [skills, projects] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
    ]);
    // Same `enabled` gate as buildChatHandler — route()'s fallback picks a skill on its own, so
    // an unfiltered list would hand back a switched-off one.
    const enabled = skills.filter((s) => s.enabled !== false);
    return route(input, enabled, projects, { chat: deps.chat, model: deps.getModel() });
  };
}

export interface ChatHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  loadMemories: (file: string) => Promise<Memory[]>;
  appendMemories: (file: string, additions: Memory[]) => Promise<void>;
  deleteMemories: (file: string, ids: string[]) => Promise<number>;
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
  /** Config `webSearch`, read per chat request so a Settings toggle applies without restart. */
  webSearch?: () => boolean;
  /** Its scratch workspace hosts delegates that aren't about a project (main.ts creates it). */
  beanDirPath?: string;
  loadRoutines?: () => Promise<Routine[]>;
  /** Enables the generate_image action tool. getModel (not a value): imageModel may live
   * behind runtime config someday; onStart drives the chat window's 🎨 working indicator. */
  imageGen?: {
    generate: ImageGenDeps["generate"]; getModel: () => string; imagesDir: string; onStart?: () => void;
    saveNoteImage?: ImageGenDeps["saveNoteImage"];
  };
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona, memories, routines] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
      deps.loadMemories(deps.dbFile),
      deps.loadRoutines?.() ?? Promise.resolve([] as Routine[]),
    ]);
    const enabled = skills.filter((s) => s.enabled !== false);
    const todoRoutines = routines.filter((r) => r.todoDriven).map((r) => r.name);
    // Per-request (not shared) so `paths` collects only this turn's generated files.
    const imageTool = deps.imageGen
      ? makeGenerateImageTool({
          generate: deps.imageGen.generate,
          model: deps.imageGen.getModel(),
          imagesDir: deps.imageGen.imagesDir,
          onStart: deps.imageGen.onStart,
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
        })
      : undefined;
    const actions = [...(deps.actions ?? []), ...(imageTool ? [imageTool.tool] : []), ...(memoryTools?.tools ?? [])];
    const result = await converse({
      history: req.history,
      latestUserText: req.message,
      latestUserImages: req.images,
      skills: enabled,
      projects,
      persona,
      memories,
      deps: { chat: deps.converse, model: deps.getModel() },
      droppedUrl: req.droppedUrl,
      actions,
      linkedNote: req.linkedNote,
      delegateAvailable: deps.delegateAvailable?.() ?? false,
      scratchPath: deps.beanDirPath ? scratchDir(deps.beanDirPath) : undefined,
      todoRoutines,
      webSearch: deps.webSearch?.() ?? false,
    });
    if (imageTool && imageTool.paths.length > 0) {
      result.generatedImages = await Promise.all(imageTool.paths.map(async (path) => ({
        path,
        dataUrl: `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
      })));
    }
    if (memoryTools && memoryTools.remembered.length > 0) result.remembered = memoryTools.remembered;
    return result;
  };
}

export interface ListSkillsHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  // `hidden: true` skills (e.g. the built-in self-intro skill) stay in converse()'s routing
  // catalog (buildChatHandler loads skills separately) but never reach any UI surface — every
  // renderer skill list/picker/quick-launch goes through this one IPC call.
  return async (): Promise<Skill[]> => (await deps.loadSkills(deps.projectSkillsDir, deps.skillsDir)).filter((s) => !s.hidden);
}

export interface ListProjectsHandlerDeps {
  loadProjects: (file: string) => Promise<Project[]>;
  projectsFile: string;
}

export function buildListProjectsHandler(deps: ListProjectsHandlerDeps) {
  return (): Promise<Project[]> => deps.loadProjects(deps.projectsFile);
}

export interface SaveProjectsHandlerDeps {
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  projectsFile: string;
}

export function buildSaveProjectsHandler(deps: SaveProjectsHandlerDeps) {
  return (projects: Project[]): Promise<void> => deps.saveProjects(deps.projectsFile, projects);
}

export interface SaveSkillHandlerDeps {
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  skillsDir: string;
}

export function buildSaveSkillHandler(deps: SaveSkillHandlerDeps) {
  return (name: string, body: string): Promise<void> => deps.saveSkill(deps.skillsDir, name, body);
}

export interface DeleteSkillHandlerDeps {
  deleteSkill: (dir: string, name: string) => Promise<void>;
  skillsDir: string;
}

export function buildDeleteSkillHandler(deps: DeleteSkillHandlerDeps) {
  return (name: string): Promise<void> => deps.deleteSkill(deps.skillsDir, name);
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
  return {
    get: async (skillName: string): Promise<string | undefined> =>
      (await deps.loadModelMemory(deps.modelMemoryFile))[skillName],
    set: async (skillName: string, modelId: string): Promise<void> => {
      const memory = await deps.loadModelMemory(deps.modelMemoryFile);
      memory[skillName] = modelId;
      await deps.saveModelMemory(deps.modelMemoryFile, memory);
    },
  };
}

export interface PersonaHandlerDeps {
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
}

export function buildPersonaHandlers(deps: PersonaHandlerDeps) {
  return {
    get: (): Promise<Persona> => deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
    save: (persona: Persona): Promise<void> => deps.savePersona(deps.personaFile, persona),
  };
}

export interface MemoryHandlerDeps {
  loadMemories: (file: string) => Promise<Memory[]>;
  // Every write is insert-only or per-row: auto-remember, a chatops bot, and the Persona panel
  // can all write at once, and a whole-list replace would silently drop one of them
  // (.memory/safety-memory-append-vs-replace.md).
  appendMemories: (file: string, additions: Memory[]) => Promise<void>;
  updateMemory: (file: string, id: string, text: string) => Promise<void>;
  deleteMemories: (file: string, ids: string[]) => Promise<number>;
  extractMemories: (
    transcript: ChatTurn[], existing: Memory[], projects: Project[], deps: ConverseDeps,
  ) => Promise<MemoryCandidate[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  /** Config `autoMemory`, read per close so a Settings toggle applies without restart. */
  autoMemory: () => boolean;
  /** A non-empty auto-remember batch landed — main shows the avatar bubble (and checks dream).
   * `pendingIds` reads the batch whose Undo is live *now* (a later close may have replaced it). */
  onMemoryBatch?: (batch: Memory[], pendingIds: () => string[]) => void;
  getLastDream: (file: string) => Promise<DreamDigest | undefined>;
  restoreDreamRun: (file: string, runId: string) => Promise<{ restored: number; skipped: number }>;
  dreamDetails: (file: string, runId: string) => Promise<{ before: string[]; after?: string }[]>;
  dbFile: string;
  projectsFile: string;
}

/** The latest auto-remember batch — Persona's "Just remembered" + Undo. Held in main's memory
 * only: the Undo window lasts until the next batch (or an app restart). */
export interface MemoryBatch { ids: string[]; at: string }

export function buildMemoryHandlers(deps: MemoryHandlerDeps) {
  let lastBatch: MemoryBatch | undefined;
  // Batch transitions (chat-close replace, MCP merge, Undo) run one at a time, so a failed
  // insert's rollback can never clobber a batch another writer set while it was awaiting.
  let batchChain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = batchChain.then(fn);
    batchChain = p.catch(() => {});
    return p;
  };
  return {
    list: (): Promise<Memory[]> => deps.loadMemories(deps.dbFile),
    append: (additions: Memory[]): Promise<void> => deps.appendMemories(deps.dbFile, additions),
    update: (id: string, text: string): Promise<void> => deps.updateMemory(deps.dbFile, id, text),
    delete: (ids: string[]): Promise<number> => deps.deleteMemories(deps.dbFile, ids),
    /** Chat-window close: extract → validate → append in the background, no review card. */
    rememberOnClose: async (transcript: ChatTurn[], opts: { incognito?: boolean }): Promise<Memory[]> => {
      if (opts.incognito || !deps.autoMemory()) return [];
      const [existing, projects] = await Promise.all([
        deps.loadMemories(deps.dbFile),
        deps.loadProjects(deps.projectsFile),
      ]);
      const candidates = await deps.extractMemories(transcript, existing, projects, { chat: deps.converse, model: deps.getModel() });
      if (candidates.length === 0) return [];
      const at = new Date().toISOString();
      const batch: Memory[] = candidates.map((c) => ({ id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: at }));
      await serial(async () => {
        // Pending before the insert lands, so a dream snapshot can never see these rows without
        // also seeing them as the live Undo batch it must leave alone.
        const prevBatch = lastBatch;
        lastBatch = { ids: batch.map((m) => m.id), at };
        try {
          await deps.appendMemories(deps.dbFile, batch);
        } catch (err) {
          lastBatch = prevBatch;
          throw err;
        }
      });
      deps.onMemoryBatch?.(batch, () => lastBatch?.ids ?? []);
      return batch;
    },
    /** An MCP remember (#225): appended and *merged* into the live Undo batch (a chat close
     * still replaces it). Returns the merged batch size for the bubble. */
    addToBatch: (additions: Memory[]): Promise<number> => serial(async () => {
      const prevBatch = lastBatch;
      lastBatch = { ids: [...(prevBatch?.ids ?? []), ...additions.map((m) => m.id)], at: new Date().toISOString() };
      try {
        await deps.appendMemories(deps.dbFile, additions);
      } catch (err) {
        lastBatch = prevBatch;
        throw err;
      }
      return lastBatch.ids.length;
    }),
    batch: (): MemoryBatch | undefined => lastBatch,
    lastDream: (): Promise<DreamDigest | undefined> => deps.getLastDream(deps.dbFile),
    /** Undo last dream: restores only groups untouched since; `skipped` = kept user edits. */
    undoLastDream: async (): Promise<{ restored: number; skipped: number }> => {
      const d = await deps.getLastDream(deps.dbFile);
      return d && !d.undone ? deps.restoreDreamRun(deps.dbFile, d.runId) : { restored: 0, skipped: 0 };
    },
    dreamDetails: async (): Promise<{ before: string[]; after?: string }[]> => {
      const d = await deps.getLastDream(deps.dbFile);
      return d ? deps.dreamDetails(deps.dbFile, d.runId) : [];
    },
    /** Deletes exactly the last batch's ids (rows edited since are still that batch's rows). */
    undoBatch: (): Promise<number> => serial(async () => {
      if (!lastBatch) return 0;
      const n = await deps.deleteMemories(deps.dbFile, lastBatch.ids);
      lastBatch = undefined;
      return n;
    }),
  };
}

// Renderer payloads are erased types by the time they cross IPC — keep only well-formed turns.
function toTranscript(v: unknown): ChatTurn[] {
  if (!Array.isArray(v)) return [];
  const sources = new Set(["typed", "loopback", "ambient", "skill", "summary"]);
  return v.flatMap((t): ChatTurn[] => {
    const o = t as Partial<ChatTurn> | null;
    if (!o || (o.role !== "user" && o.role !== "assistant") || typeof o.content !== "string") return [];
    return [{ role: o.role, content: o.content, source: sources.has(o.source as string) ? o.source : undefined }];
  });
}

export interface NotesHandlerDeps {
  loadNotes: (file: string) => Promise<Note[]>;
  saveNote: (file: string, draft: NoteDraft) => Promise<string>;
  deleteNote: (file: string, slug: string) => Promise<void>;
  starNote: (file: string, slug: string, starred: boolean) => Promise<void>;
  loadNoteHistory: (file: string, slug: string) => Promise<Note[]>;
  saveNoteImage: (file: string, bytes: Uint8Array) => Promise<string>;
  loadNoteImage: (file: string, id: string) => Promise<{ mime: string; bytes: Uint8Array } | undefined>;
  dbFile: string;
}

export function buildNotesHandlers(deps: NotesHandlerDeps) {
  const storeImage = (bytes: Uint8Array): Promise<string> => deps.saveNoteImage(deps.dbFile, bytes);
  return {
    list: (): Promise<Note[]> => deps.loadNotes(deps.dbFile),
    // `images` = the chat's latest attached images carried into a desktop propose_note save;
    // core stores them and appends code-written bean-image refs (limits re-checked there).
    save: async (draft: NoteDraft, images?: unknown): Promise<string> => {
      const valid = Array.isArray(images)
        ? images.filter((i): i is ImageAttachment => typeof (i as ImageAttachment)?.data === "string")
        : [];
      const body = valid.length > 0 ? await attachNoteImages(storeImage, draft.body, valid) : draft.body;
      return deps.saveNote(deps.dbFile, { ...draft, body });
    },
    // Trust boundary for editor paste/drop: bytes only, never a path; size capped here before
    // storing, format checked by magic bytes in core.
    saveImage: (bytes: unknown): Promise<string> => {
      if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error("note image must be raw bytes"));
      if (bytes.byteLength > MAX_NOTE_IMAGE_BYTES) return Promise.reject(new Error("image is larger than 10 MB"));
      return storeImage(bytes);
    },
    /** A stored note image as a data: URL, or undefined for an unknown/malformed id. */
    image: async (id: unknown): Promise<string | undefined> => {
      if (typeof id !== "string") return undefined;
      const img = await deps.loadNoteImage(deps.dbFile, id);
      return img ? `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}` : undefined;
    },
    delete: (slug: string): Promise<void> => deps.deleteNote(deps.dbFile, slug),
    star: (slug: string, starred: boolean): Promise<void> => deps.starNote(deps.dbFile, slug, starred),
    history: (slug: string): Promise<Note[]> => deps.loadNoteHistory(deps.dbFile, slug),
  };
}

export interface ConfigHandlerDeps {
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  onApplied?: () => void;
}

export function buildConfigHandlers(deps: ConfigHandlerDeps) {
  return {
    get: (): ConfigView => deps.getConfig(),
    save: async (update: ConfigUpdate): Promise<void> => {
      await deps.applyConfig(update);
      deps.onApplied?.();
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

export interface RoutineStateView {
  lastRun?: string; missed?: boolean; history: RunRecord[]; running: boolean;
  /** Watch routines only. */
  lastPoll?: string; pollError?: string; pollFailures?: number;
  /** false = never enabled since its source was set — the list shows "needs review". */
  seeded?: boolean;
  queue?: { pending: number; running: number };
}

/** Who a chatops sink with no channel reaches (counts only — the app can't look up names). */
export interface SinkRecipients { discord?: number; teams?: number }
export interface BriefDraft { brief: RoutineBrief; tools: string[] }

/** Watch + builder verbs. Optional so tests (and a boot without them) can omit the lot. */
export interface RoutineWatchDeps {
  isSeeded: (routine: Routine) => boolean;
  queueCounts: (name: string) => Promise<{ pending: number; running: number }>;
  pollFailures: (name: string) => number;
  checkNow: (name: string) => Promise<WatchCheckResult>;
  previewWatch: (watch: RoutineWatch) => Promise<WatchItem[]>;
  enableWatch: (name: string, queueExisting: boolean) => Promise<{ count: number }>;
  sinkRecipients: () => Promise<SinkRecipients>;
  draftBrief: (sentence: string, previous?: RoutineBrief) => Promise<BriefDraft>;
  builds: {
    list: () => RoutineBuildView[];
    start: (brief: RoutineBrief) => Promise<void>;
    cancel: (name: string) => void;
    dismiss: (name: string) => void;
  };
}

export interface RoutineHandlerDeps {
  loadRoutines: () => Promise<Routine[]>;
  saveRoutine: (routine: Routine) => Promise<void>;
  deleteRoutine: (name: string) => Promise<void>;
  loadStates: () => Promise<Record<string, RoutineState>>;
  isRunning: (name: string) => boolean;
  runNow: (name: string) => Promise<{ started: boolean; reason?: string }>;
  onRoutineDeleted?: (name: string) => Promise<void>;
  watch?: RoutineWatchDeps;
}

export function buildRoutineHandlers(deps: RoutineHandlerDeps) {
  const watch = (): RoutineWatchDeps => {
    if (!deps.watch) throw new Error("watch routines aren't available");
    return deps.watch;
  };
  return {
    list: (): Promise<Routine[]> => deps.loadRoutines(),
    save: async (routine: Routine): Promise<void> => {
      await deps.saveRoutine(routine);
    },
    remove: async (name: string): Promise<void> => {
      await deps.deleteRoutine(name);
      await deps.onRoutineDeleted?.(name);
    },
    state: async (): Promise<Record<string, RoutineStateView>> => {
      const [routines, states] = await Promise.all([deps.loadRoutines(), deps.loadStates()]);
      const out: Record<string, RoutineStateView> = {};
      for (const r of routines) {
        const s = states[r.name];
        out[r.name] = { lastRun: s?.lastRun, missed: s?.missed, history: s?.history ?? [], running: deps.isRunning(r.name) };
        if (r.watch && deps.watch) {
          Object.assign(out[r.name]!, {
            lastPoll: s?.lastPoll, pollError: s?.pollError, pollFailures: deps.watch.pollFailures(r.name),
            seeded: deps.watch.isSeeded(r),
            ...(r.todoDriven ? { queue: await deps.watch.queueCounts(r.name) } : {}),
          });
        }
      }
      return out;
    },
    runNow: (name: string): Promise<{ started: boolean; reason?: string }> => deps.runNow(name),
    checkNow: (name: string): Promise<WatchCheckResult> => watch().checkNow(name),
    previewWatch: (w: RoutineWatch): Promise<WatchItem[]> => watch().previewWatch(w),
    enableWatch: (name: string, queueExisting: boolean): Promise<{ count: number }> => watch().enableWatch(name, queueExisting === true),
    sinkRecipients: (): Promise<SinkRecipients> => watch().sinkRecipients(),
    draftBrief: (sentence: string, previous?: RoutineBrief): Promise<BriefDraft> => {
      if (typeof sentence !== "string" || !sentence.trim()) throw new Error("describe the routine first");
      return watch().draftBrief(sentence.trim().slice(0, 2000), previous);
    },
    build: (brief: RoutineBrief): Promise<void> => watch().builds.start(brief),
    builds: (): RoutineBuildView[] => deps.watch?.builds.list() ?? [],
    cancelBuild: (name: string): void => watch().builds.cancel(name),
    dismissBuild: (name: string): void => watch().builds.dismiss(name),
  };
}

export interface TodoHandlerDeps {
  dbFile: string;
  loadRoutines: () => Promise<Routine[]>;
  addTodo: (file: string, routine: string, text: string) => Promise<TodoItem>;
  listTodos: (file: string, routine: string) => Promise<TodoItem[]>;
  listAllTodos: (file: string) => Promise<TodoItem[]>;
  editTodoText: (file: string, id: string, text: string) => Promise<void>;
  deleteTodo: (file: string, id: string) => Promise<void>;
  reorderTodo: (file: string, id: string, newOrder: number) => Promise<void>;
  clearFinishedTodos: (file: string, routine: string) => Promise<void>;
  retryTodo: (file: string, id: string) => Promise<void>;
}

export function buildTodoHandlers(deps: TodoHandlerDeps) {
  return {
    list: (routine: string): Promise<TodoItem[]> => deps.listTodos(deps.dbFile, routine),
    listAll: (): Promise<TodoItem[]> => deps.listAllTodos(deps.dbFile),
    // Routine existence/type is enforced here, not in the store (store stays dumb, per spec).
    add: async (routine: string, text: string): Promise<TodoItem> => {
      resolveTodoRoutine(await deps.loadRoutines(), routine);
      return deps.addTodo(deps.dbFile, routine, text);
    },
    edit: (id: string, text: string): Promise<void> => deps.editTodoText(deps.dbFile, id, text),
    remove: (id: string): Promise<void> => deps.deleteTodo(deps.dbFile, id),
    reorder: (id: string, newOrder: number): Promise<void> => deps.reorderTodo(deps.dbFile, id, newOrder),
    clearFinished: (routine: string): Promise<void> => deps.clearFinishedTodos(deps.dbFile, routine),
    retry: (id: string): Promise<void> => deps.retryTodo(deps.dbFile, id),
  };
}

export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps, ChatopsHandlerDeps, UpdateHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  deleteSkill: (dir: string, name: string) => Promise<void>;
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
  loadMemories: (file: string) => Promise<Memory[]>;
  appendMemories: MemoryHandlerDeps["appendMemories"];
  updateMemory: MemoryHandlerDeps["updateMemory"];
  deleteMemories: MemoryHandlerDeps["deleteMemories"];
  extractMemories: MemoryHandlerDeps["extractMemories"];
  autoMemory: MemoryHandlerDeps["autoMemory"];
  onMemoryBatch?: MemoryHandlerDeps["onMemoryBatch"];
  getLastDream: MemoryHandlerDeps["getLastDream"];
  restoreDreamRun: MemoryHandlerDeps["restoreDreamRun"];
  dreamDetails: MemoryHandlerDeps["dreamDetails"];
  loadNotes: NotesHandlerDeps["loadNotes"];
  saveNote: NotesHandlerDeps["saveNote"];
  deleteNote: NotesHandlerDeps["deleteNote"];
  starNote: NotesHandlerDeps["starNote"];
  loadNoteHistory: NotesHandlerDeps["loadNoteHistory"];
  saveNoteImage: NotesHandlerDeps["saveNoteImage"];
  loadNoteImage: NotesHandlerDeps["loadNoteImage"];
  dbFile: string;
  actions?: ActionTool[];
  delegateAvailable?: () => boolean;
  webSearch?: () => boolean;
  imageGen?: ChatHandlerDeps["imageGen"];
  broadcast: (channel: string, payload: unknown) => void;
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  getPendingPlan: () => RouteSuggestion | undefined;
  getPendingDroppedUrl: () => string | undefined;
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
  };
  onLaunchError?: (req: LaunchRequest, err: Error) => void;
  /** Called as a chat turn starts; the returned fn is called when it ends (with the failure, if any). */
  onChatTurn?: () => (error?: string) => void;
  loadRoutines?: () => Promise<Routine[]>;
  routineHandlers: ReturnType<typeof buildRoutineHandlers>;
  todoHandlers: ReturnType<typeof buildTodoHandlers>;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): { memoryHandlers: ReturnType<typeof buildMemoryHandlers> } {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));

  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, async (_e, req: ChatRequest) => {
    const end = deps.onChatTurn?.();
    try {
      const result = await chatHandler(req);
      end?.(result.error);
      return result;
    } catch (err) {
      end?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
  ipcMain.handle(IPC.getModel, () => deps.getModel());

  const listSkillsHandler = buildListSkillsHandler(deps);
  ipcMain.handle(IPC.listSkills, () => listSkillsHandler());

  const listProjectsHandler = buildListProjectsHandler(deps);
  ipcMain.handle(IPC.listProjects, () => listProjectsHandler());

  const saveProjectsHandler = buildSaveProjectsHandler(deps);
  ipcMain.handle(IPC.saveProjects, (_e, projects: Project[]) => saveProjectsHandler(projects));

  // Native folder picker so "add project" can browse instead of hand-typing a path.
  ipcMain.handle(IPC.pickProjectFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  // Native .app picker for the Settings "Terminal App" field — same shape as pickProjectFolder,
  // just filtered to application bundles and defaulted to /Applications.
  ipcMain.handle(IPC.pickTerminalApp, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile"] as ("openFile")[],
      filters: [{ name: "Applications", extensions: ["app"] }],
      defaultPath: "/Applications",
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? undefined : result.filePaths[0];
  });

  // Same picker as pickTerminalApp, for the Settings "Editor App" field.
  ipcMain.handle(IPC.pickEditorApp, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile"] as ("openFile")[],
      filters: [{ name: "Applications", extensions: ["app"] }],
      defaultPath: "/Applications",
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? undefined : result.filePaths[0];
  });

  // "Reveal in Finder" from the Projects panel — just hands the path to Finder, no launch involved.
  ipcMain.on(IPC.revealInFinder, (_e, path: string) => shell.showItemInFolder(path));

  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const deleteSkillHandler = buildDeleteSkillHandler(deps);
  ipcMain.handle(IPC.deleteSkill, (_e, name: string) => deleteSkillHandler(name));

  const launchHandler = buildLaunchHandler(deps);
  ipcMain.on(IPC.launch, (_e, req: LaunchRequest) => launchHandler(req));
  ipcMain.handle(IPC.delegateStart, (_e, req: DelegateStartRequest) => deps.delegateTasks.start(req));
  ipcMain.on(IPC.delegateCancel, (_e, taskId: string) => deps.delegateTasks.cancel(taskId));
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

  const memoryHandlers = buildMemoryHandlers(deps);
  ipcMain.handle(IPC.listMemories, () => memoryHandlers.list());
  ipcMain.handle(IPC.appendMemories, (_e, additions: Memory[]) => memoryHandlers.append(additions));
  ipcMain.handle(IPC.updateMemory, (_e, id: string, text: string) => memoryHandlers.update(id, text));
  ipcMain.handle(IPC.deleteMemories, (_e, ids: string[]) => memoryHandlers.delete(ids));
  // Fire-and-forget: the chat window is already closing. Failures just mean nothing was saved.
  ipcMain.on(IPC.rememberOnClose, (_e, transcript: unknown, opts: unknown) => {
    const incognito = (opts as { incognito?: unknown } | null)?.incognito === true;
    memoryHandlers.rememberOnClose(toTranscript(transcript), { incognito }).catch((err) => {
      console.error("auto-remember failed:", err);
    });
  });
  ipcMain.handle(IPC.getMemoryBatch, () => memoryHandlers.batch());
  ipcMain.handle(IPC.undoMemoryBatch, () => memoryHandlers.undoBatch());
  ipcMain.handle(IPC.getLastDream, () => memoryHandlers.lastDream());
  ipcMain.handle(IPC.undoLastDream, () => memoryHandlers.undoLastDream());
  ipcMain.handle(IPC.dreamDetails, () => memoryHandlers.dreamDetails());

  const notesHandlers = buildNotesHandlers(deps);
  ipcMain.handle(IPC.listNotes, () => notesHandlers.list());
  ipcMain.handle(IPC.saveNote, (_e, draft: NoteDraft, images?: unknown) => notesHandlers.save(draft, images));
  ipcMain.handle(IPC.saveNoteImage, (_e, bytes: unknown) => notesHandlers.saveImage(bytes));
  ipcMain.handle(IPC.noteImage, (_e, id: unknown) => notesHandlers.image(id));
  ipcMain.handle(IPC.deleteNote, (_e, slug: string) => notesHandlers.delete(slug));
  // === true, not a cast: the renderer's types are erased by the time a value crosses IPC,
  // and every truthy payload ("false" included) would otherwise star the note.
  ipcMain.handle(IPC.starNote, (_e, slug: string, starred: unknown) => notesHandlers.star(slug, starred === true));
  ipcMain.handle(IPC.noteHistory, (_e, slug: string) => notesHandlers.history(slug));

  const configHandlers = buildConfigHandlers({
    getConfig: deps.getConfig,
    applyConfig: deps.applyConfig,
    onApplied: () => deps.broadcast(IPC.cliAvailabilityChanged, undefined),
  });
  ipcMain.handle(IPC.getConfig, () => configHandlers.get());
  ipcMain.handle(IPC.saveConfig, (_e, update: ConfigUpdate) => configHandlers.save(update));
  ipcMain.handle(IPC.getAppInfo, () => deps.getAppInfo());

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.broadcast(IPC.themeChanged, next);
  });

  const chatopsHandlers = buildChatopsHandlers(deps);
  ipcMain.handle(IPC.chatopsStatus, () => chatopsHandlers.status());
  ipcMain.on(IPC.chatopsStart, (_e, bot: ChatopsBot) => chatopsHandlers.start(bot));
  ipcMain.on(IPC.chatopsStop, (_e, bot: ChatopsBot) => chatopsHandlers.stop(bot));

  const updateHandlers = buildUpdateHandlers(deps);
  ipcMain.handle(IPC.checkForUpdate, () => updateHandlers.check());
  ipcMain.handle(IPC.installUpdate, () => updateHandlers.install());
  ipcMain.on(IPC.openUpdateReleasePage, () => updateHandlers.openReleasesPage());

  ipcMain.handle(IPC.routinesList, () => deps.routineHandlers.list());
  ipcMain.handle(IPC.routinesSave, (_e, routine: Routine) => deps.routineHandlers.save(routine));
  ipcMain.handle(IPC.routinesDelete, (_e, name: string) => deps.routineHandlers.remove(name));
  ipcMain.handle(IPC.routinesState, () => deps.routineHandlers.state());
  ipcMain.handle(IPC.routinesRunNow, (_e, name: string) => deps.routineHandlers.runNow(name));
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

  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, droppedUrl?: string) => deps.openComponent(kind, droppedUrl));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
  ipcMain.handle(IPC.getPendingPlan, () => deps.getPendingPlan());
  ipcMain.handle(IPC.getPendingDroppedUrl, () => deps.getPendingDroppedUrl());
  ipcMain.on(IPC.planFromDrop, (_e, skillName: string, droppedUrl: string) => deps.planFromDrop(skillName, droppedUrl));
  ipcMain.on(IPC.runInChat, (_e, payload: ChatPromptPayload) => deps.runInChat(payload));
  ipcMain.handle(IPC.getPendingChatPrompt, () => deps.getPendingChatPrompt());
  ipcMain.handle(IPC.getPendingInterruptedRunNotices, () => deps.getPendingInterruptedRunNotices());

  // Lets a component window grow to fit its own content (e.g. About growing when an update
  // notice appears) instead of clipping it. Width is left alone; height only grows/shrinks to
  // what the renderer measured, clamped to the display's work area.
  ipcMain.on(IPC.resizeWindowToContent, (e, height: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const [width] = win.getContentSize();
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setContentSize(width ?? 0, Math.min(Math.round(height), workArea.height), true);
  });
  return { memoryHandlers };
}
