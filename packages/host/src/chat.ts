import {
  converse, checkPdfAttachment, scratchDir, makeGenerateImageTool, makeMemoryTools, memoryCategories, type ImageGenDeps,
  checkImageAttachments, compactHistory, availableModels, planSproutRun, makeBackgroundWorkTool, threadDispatches, type SproutRunBlock,
  type Project, type Skill, type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type CliName, type Memory, type ActionTool, type AvailableModel, type Routine, type CliModels, type SendCard,
  DESKTOP_CHAT_MAX_BYTES, HOME_THREAD_ID, HOME_THREAD_TITLE, type HomePost, type DesktopChat, type DesktopChatInput, type DesktopChatListing, type DispatchStatus,
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
  /** Whether this chat's client can take a Terminal.app hand-off (core `runAvailable`); default yes. */
  runAvailable?: (clientId: ClientId) => boolean;
  /** Config `webSearch`, read per chat request so a Settings toggle applies without restart. */
  webSearch?: () => boolean;
  /** Its scratch workspace hosts delegates that aren't about a project (main.ts creates it). */
  beanDirPath?: string;
  loadRoutines?: () => Promise<Routine[]>;
  /** A sprout's pending todos and whether its watch is seeded — enables propose_sprout_run. */
  sproutFacts?: (routine: Routine) => Promise<{ pending: number; seeded: boolean }>;
  /** Enables background_work (#924): the sprouts' state file, the live run counts, and the chat
   * threads this chat (mount) dispatched from. */
  backgroundWork?: {
    stateFile: string;
    running: () => { name: string; runs: number }[] | undefined;
    threadsOf: (mountId: string) => string[];
  };
  /** A routine's pending todos: a todo card's "N ahead in queue" (#923). */
  todoAhead?: (routine: string) => number;
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
    const work = deps.backgroundWork;
    // The desktop is the owner's own machine: background_work shows everything (no viewer).
    const workTool = work
      ? makeBackgroundWorkTool({
          file: deps.dbFile, stateFile: work.stateFile, running: async () => work.running(),
          dispatches: () => (mountId === undefined ? [] : work.threadsOf(mountId).flatMap((t) => threadDispatches(deps.dbFile, t))),
        })
      : undefined;
    const actions = [...(deps.actions ?? []), ...(imageTool ? [imageTool.tool] : []), ...(memoryTools?.tools ?? []), ...(workTool ? [workTool] : [])];
    // Bounded here, on the core (a remote shell never holds the API key): the summary rides back
    // with the reply and the shell keeps it as a hidden item (#975).
    const compacted = await compactHistory(req.history, req.summary, { chat: deps.converse, model: deps.getModel() }, signal);
    const result = await converse({
      history: compacted.history,
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
      sproutCatalog: deps.sproutFacts ? routines.map((r) => ({ name: r.name, description: r.description, takesTask: r.todoDriven })) : [],
      webSearch: deps.webSearch?.() ?? false,
      runAvailable: clientId === undefined || (deps.runAvailable?.(clientId) ?? true),
      sendAvailable: deps.proposeSend !== undefined,
      signal,
    });
    if (compacted.summary) result.summary = compacted.summary;
    if (result.proposedSend && deps.proposeSend) {
      result.sendCard = deps.proposeSend(result.proposedSend.destination, result.proposedSend.text);
      delete result.proposedSend;
    }
    if (result.proposedSproutRun && deps.sproutFacts) await planSproutCard(result, routines, deps.sproutFacts);
    if (result.proposedTodo && deps.todoAhead) {
      try { result.proposedTodo = { ...result.proposedTodo, ahead: deps.todoAhead(result.proposedTodo.routine) }; } catch { /* the card just omits it */ }
    }
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
export interface ChatThreadAck { id: string; title: string; updatedAt: string; home?: true }
/** What a chat restores: a saved thread, or `missing` when the picked one is gone (deleted or
 * pruned) — the chat opens empty with a status row. */
export type PendingChatThread = {
  id: string; title: string; items: unknown[]; noteSlug: string | null; sprouts?: SproutOutcome[];
  /** Home (#960): its pending posts, handed to this chat to append and drain with its next save. */
  home?: { posts: HomePost[] };
} | { missing: true };

/** A sprout run a desktop chat started (#921), as its card learns it: `status` absent = still
 * running; `text` = the finish line + the run's brief, fenced as data (dispatchContext) — the
 * result turn the chat loops back. Pushed (`sprout` mount push, with `mountId`) when the run's
 * dispatch is delivered, and listed with a restored thread (`sprouts`) for the cards it holds. */
export interface SproutOutcome { jobId: string; status?: DispatchStatus; text?: string }
export type SproutEvent = Required<SproutOutcome> & { mountId: string };
/** A run's admission, pushed the same way before its end (no `status`): a remote shell whose start
 * reply a dropped link lost learns the run's job id from it (#922). The chat ignores it. */
export interface SproutStarted { mountId: string; jobId: string; name: string }
export type SproutPush = SproutEvent | SproutStarted;

export interface ChatThreadHandlerDeps {
  saveDesktopChat: (file: string, chat: DesktopChatInput, now?: Date) => string;
  getDesktopChat: (file: string, id: string) => DesktopChat | undefined;
  deleteDesktopChat: (file: string, id: string) => void;
  starDesktopChat: (file: string, id: string, starred: boolean) => string | undefined;
  renameDesktopChat: (file: string, id: string, title: string) => string | undefined;
  groupDesktopChats: (file: string, ids: string[], name: string | null) => string[];
  renameDesktopChatGroup: (file: string, from: string, to: string) => string[];
  listDesktopChats: (file: string) => DesktopChatListing[];
  /** Home posts (#960); absent = Home opens with no posts and a save drains nothing. */
  listPendingHomePosts?: (file: string) => HomePost[];
  saveDesktopChatDraining?: (file: string, chat: DesktopChatInput, drained: readonly string[], now?: Date) => string;
  /** A save drained Home posts (#961): the host recounts its bubble. */
  onDrained?: () => void;
  now?: () => Date;
  dbFile: string;
}

/** A saved `post` item the shell's restore keeps (chat-thread.ts normalizeItem — keep in step): only
 * such an item may drain its post, so a drained post always comes back with the transcript. */
function postShape(it: unknown): { postId: string } | undefined {
  const p = it as { kind?: unknown; id?: unknown; postId?: unknown; sprout?: unknown; at?: unknown; text?: unknown } | null;
  return typeof p === "object" && p !== null && p.kind === "post" && typeof p.id === "string" && typeof p.postId === "string"
    && typeof p.sprout === "string" && typeof p.at === "string" && typeof p.text === "string" ? { postId: p.postId } : undefined;
}

/** `chatThreadGet`'s name for today's Home thread (#960) — the shell can't know the core-local date. */
export const HOME_TARGET = "home";

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Per chat: the Home posts handed to it with Home — the only ids its saves may drain.
  const handed = new Map<string, { thread: string; ids: Set<string> }>();
  const now = (): Date => deps.now?.() ?? new Date();
  const isHome = (id: string): boolean => id === HOME_THREAD_ID;
  const holder = (id: string): string | undefined => [...threads].find(([, t]) => t === id)?.[0];
  /** A saved thread for this chat to restore (pinned to it), or `missing` when it's gone. Home
   * (`HOME_TARGET` or its id) is never missing: an empty thread until its first save, with the
   * pending posts. */
  const get = (key: string, target: unknown): PendingChatThread => {
    const id = target === HOME_TARGET ? HOME_THREAD_ID : target;
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
    const pinned = threads.get(key);
    if (pinned !== undefined && pinned !== id) throw new Error("this chat saves a different chat thread");
    const other = holder(id);
    if (other !== undefined && other !== key) throw new Error("that chat is already open");
    const home = isHome(id);
    const row = deps.getDesktopChat(deps.dbFile, id);
    if (!row && !home) return { missing: true };
    let items: unknown = [];
    if (row) try { items = JSON.parse(row.itemsJson); } catch { items = []; }
    if (!unsavable.has(key)) threads.set(key, id);
    const thread = { id, title: row?.title ?? HOME_THREAD_TITLE, items: Array.isArray(items) ? items : [], noteSlug: row?.noteSlug ?? null };
    if (!home || unsavable.has(key)) return thread;
    const posts = deps.listPendingHomePosts?.(deps.dbFile) ?? [];
    handed.set(key, { thread: id, ids: new Set([...(handed.get(key)?.thread === id ? handed.get(key)!.ids : []), ...posts.map((p) => p.id)]) });
    return { ...thread, home: { posts } };
  };
  /** Home is pinned in the sidebar: never deleted, starred, renamed or grouped. */
  const notHome = (id: string, what: string): void => {
    if (isHome(id)) throw new Error(`Home can't be ${what}`);
  };
  return {
    list: (): DesktopChatListing[] => deps.listDesktopChats(deps.dbFile).map((t) => (isHome(t.id) ? { ...t, home: true } : t)),
    /** Sidebar delete: never a thread an open chat holds. */
    delete: (id: unknown): void => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      notHome(id, "deleted");
      if (holder(id) !== undefined) throw new Error("an open chat can't be deleted");
      deps.deleteDesktopChat(deps.dbFile, id);
    },
    /** Sidebar star: any thread, open or not. The thread's `updatedAt`, or undefined when it's gone. */
    star: (id: unknown, starred: unknown): string | undefined => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      if (typeof starred !== "boolean") throw new Error("starred must be a boolean");
      notHome(id, "starred");
      return deps.starDesktopChat(deps.dbFile, id, starred);
    },
    /** Sidebar rename: any thread, open or not. The stored title, or undefined when it's gone. */
    rename: (id: unknown, title: unknown): string | undefined => {
      if (typeof id !== "string" || !THREAD_ID.test(id)) throw new Error("chat thread id must be a UUID");
      if (typeof title !== "string") throw new Error("title must be a string");
      notHome(id, "renamed");
      return deps.renameDesktopChat(deps.dbFile, id, title);
    },
    /** Sidebar group (stars too) / ungroup (`null`, keeps the star): 1–100 unique UUIDs, open or not.
     * The ids it updated; gone ones are skipped. */
    group: (ids: unknown, name: unknown): string[] => {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new Error("chat thread ids must be 1–100 UUIDs");
      if (!ids.every((id) => typeof id === "string" && THREAD_ID.test(id))) throw new Error("chat thread id must be a UUID");
      if (new Set(ids.map((id: string) => id.toLowerCase())).size !== ids.length) throw new Error("chat thread ids must be unique");
      if (name !== null && typeof name !== "string") throw new Error("group name must be a string or null");
      for (const id of ids as string[]) notHome(id, "grouped");
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
      const at = now();
      const chat = { id: o.id, title: o.title, itemsJson, noteSlug: o.noteSlug ?? null };
      // Home posts (#960) drain with the save that holds them: the `post` items in this transcript
      // whose ids were handed to this chat with this thread — never another chat's, never a guess.
      const mine = handed.get(key);
      const drained = mine?.thread !== o.id ? [] : [...new Set(o.items.flatMap((it) => {
        const p = postShape(it);
        return p && mine.ids.has(p.postId) ? [p.postId] : [];
      }))];
      // The stored title, not the renderer's: a rename since the first save wins over the open chat's copy.
      const title = drained.length > 0 && deps.saveDesktopChatDraining
        ? deps.saveDesktopChatDraining(deps.dbFile, chat, drained, at)
        : deps.saveDesktopChat(deps.dbFile, chat, at);
      for (const x of drained) mine?.ids.delete(x);
      threads.set(key, o.id);
      if (drained.length > 0) deps.onDrained?.();
      return { id: o.id, title, updatedAt: at.toISOString(), ...(isHome(o.id) ? { home: true as const } : {}) };
    },
    /** 🕶 on: latch first, then delete the chat's saved row. Off: nothing — the latch is sticky. */
    setIncognito: (key: string, on: boolean): void => {
      if (!on) return;
      // Home can't go off the record (the shell opens a separate chat instead); never deleted here.
      const pinned = threads.get(key);
      if (pinned !== undefined && isHome(pinned)) return;
      unsavable.add(key);
      const id = threads.get(key);
      if (id !== undefined) deps.deleteDesktopChat(deps.dbFile, id);
    },
    /** The open chat (mount key) that holds this thread, if any. */
    holderOf: holder,
    /** The thread this chat writes, once pinned. */
    pinnedOf: (key: string): string | undefined => threads.get(key),
    exists: (id: string): boolean => deps.getDesktopChat(deps.dbFile, id) !== undefined,
    /** The chat mount is gone: its thread is free to delete or reopen. */
    release: (key: string): void => {
      threads.delete(key);
      unsavable.delete(key);
      handed.delete(key);
    },
  };
}
