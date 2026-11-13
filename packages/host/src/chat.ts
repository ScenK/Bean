import {
  converse, checkPdfAttachment, scratchDir, makeGenerateImageTool, makeMemoryTools, memoryCategories, type ImageGenDeps,
  checkImageAttachments, availableModels, planSproutRun, type SproutRunBlock,
  type Project, type Skill, type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type CliName, type Memory, type ActionTool, type AvailableModel, type Routine, type CliModels, type SendCard,
  DESKTOP_CHAT_MAX_BYTES, type DesktopChat, type DesktopChatInput, type DesktopChatListing,
} from "@bean/core";
import { readFile } from "node:fs/promises";
import type { ClientId } from "./shell-ops.js";

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
    /** The client a mount is attached to now (never a released one). */
    holder: (id: string): ClientId | undefined => mounts.get(id),
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
