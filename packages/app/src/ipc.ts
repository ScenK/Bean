import {
  launchInTerminal, scratchDir, availableModels, pickModel, planForDroppedSkill,
  type Project, type RouteSuggestion, type LaunchRequest, type LaunchSpawnFn, type CliName, type Memory, type NoteDraft,
  type Persona, type Routine, type CliModels, type RoutineBrief, type RoutineWatch, type ChatRequest,
} from "@bean/core";
import {
  buildConfigHandlers, type ConfigUpdate, type DelegateStartRequest, type Handshake, type HostHandlers, type ShellOps,
} from "@bean/host";
import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { IPC, type Theme, type ComponentKind, type DashboardTarget, type ChatDrop, type DroppedImage, type AppInfo, type UpdateStatus, type InstallUpdateResult, type CoreListing, type CoreStatus } from "./channels.js";
import { terminalLink, type TerminalTasks } from "./terminal-tasks.js";
import { chatPathTarget, openChatPath } from "./chat-open-path.js";
import type { ChatopsBot, ChatopsState } from "@bean/host";
import type { UpdateCheckOutcome } from "./updater.js";
import type { buildSyncedChatHandlers } from "./synced-chats.js";
import type { buildDeskContinueHandler } from "./desk-continue.js";
import type { Push } from "./push.js";
import { guardIpc, type IpcLike } from "./channel-contract.js";

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

/** The shell's own channels (theme, updates, windows and their pull-on-mount stores, About): they work
 * with or without a core attached. */
export interface ShellIpcDeps extends ThemeHandlerDeps, UpdateHandlerDeps {
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
  getAppInfo: () => AppInfo;
  /** The core list and the attachment's state (#811) — main.ts; every argument is unchecked here. */
  cores: {
    list: () => Promise<CoreListing>;
    add: (host: unknown, container: unknown) => Promise<{ id: string } | { error: string }>;
    remove: (id: unknown) => Promise<void>;
    /** Saves the pick and restarts Bean, once the chat window's Keep/Stop review lets it close. */
    switchTo: (id: unknown) => void;
    status: () => CoreStatus;
    takeBack: () => void;
    /** The Keep/Stop card's "Keep working": whatever was waiting on the chat closing is off. */
    closeKept: () => void;
  };
}

export interface RegisterDeps extends ChatopsHandlerDeps {
  /** The Electron-free host's handlers (`@bean/host` createHost): chats, registries, stores. */
  host: HostHandlers;
  push: Push;
  /** What this host offers (contract version, core version, platform, capabilities); its capabilities
   * gate the host-bound channels. */
  handshake: Handshake;
  /** Dialogs, Finder, the browser and window sizing — Electron, injected (app/src/shell-ops.ts). */
  shell: ShellOps;
  spawnLaunch?: LaunchSpawnFn;
  getTerminalApp: () => string;
  getEditorApp: () => string;
  getAvailableClis: () => CliName[];
  getCliModels: () => CliModels[];
  beanDirPath: string;
  onLaunchError?: (req: LaunchRequest, err: Error) => void;
  /** The chat's pty terminals — shell-owned (node-pty), keyed by the host's chat mounts. */
  terminalTasks: Pick<TerminalTasks, "start" | "write" | "resize" | "ack" | "stop" | "stopMount" | "runningCommand">;
  /** Whether a client is the chat window. */
  isChatClient: (clientId: number) => boolean;
  syncedChatHandlers: ReturnType<typeof buildSyncedChatHandlers>;
  /** Continue in Discord; absent = not offered (refused). */
  deskContinue?: ReturnType<typeof buildDeskContinueHandler>;
}

/** The Electron IPC adapter for a local core: every core and host-bound channel (channels.ts) to its host
 * handler, with the sender's webContents id as the client id. Each call passes the contract
 * (channel-contract.ts) first. Per-chat state and its checks live in the host (`host.chat`). The shell's
 * own channels are `registerShellIpc`'s. */
export function registerIpc(electronIpc: IpcLike, deps: RegisterDeps): void {
  const { host } = deps;
  const ipcMain = guardIpc(electronIpc, deps.handshake.capabilities);
  ipcMain.handle(IPC.handshake, () => deps.handshake);
  const chats = host.chat;
  ipcMain.on(IPC.chatAttach, (e, mountId: unknown) => chats.attach(e.sender.id, mountId));
  ipcMain.on(IPC.chatRelease, (e, mountId: unknown) => chats.release(e.sender.id, mountId));
  ipcMain.handle(IPC.chat, (e, req: ChatRequest, mountId: unknown) => chats.chat(e.sender.id, mountId, req));
  ipcMain.on(IPC.chatStop, (e, mountId: unknown, turnId: unknown) => chats.stop(e.sender.id, mountId, turnId));
  ipcMain.handle(IPC.chatStageImage, (e, data: unknown, mime: unknown, mountId: unknown) => chats.stageImage(e.sender.id, mountId, data, mime));
  ipcMain.handle(IPC.getModel, () => host.getModel());
  ipcMain.on(IPC.dismissTask, (_e, id: unknown) => { if (typeof id === "string") host.dismissTask(id); });

  ipcMain.handle(IPC.listSkills, () => host.listSkills());
  ipcMain.handle(IPC.listProjects, () => host.listProjects());
  ipcMain.handle(IPC.saveProjects, (_e, projects: Project[]) => host.saveProjects(projects));

  // Native pickers (Settings' Terminal/Editor App fields, "add project") and Finder reveal.
  ipcMain.handle(IPC.pickProjectFolder, (e) => deps.shell.pickFolder(e.sender.id));
  ipcMain.handle(IPC.pickTerminalApp, (e) => deps.shell.pickApp(e.sender.id));
  ipcMain.handle(IPC.pickEditorApp, (e) => deps.shell.pickApp(e.sender.id));
  ipcMain.on(IPC.revealInFinder, (_e, path: string) => deps.shell.reveal(path));

  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => host.saveSkill(name, body));
  ipcMain.handle(IPC.deleteSkill, (_e, name: string) => host.deleteSkill(name));

  const launchHandler = buildLaunchHandler(deps);
  ipcMain.on(IPC.launch, (_e, req: LaunchRequest) => launchHandler(req));
  ipcMain.handle(IPC.delegateStart, (e, req: DelegateStartRequest, mountId: unknown) => chats.delegateStart(e.sender.id, mountId, req));
  ipcMain.on(IPC.delegateCancel, (_e, taskId: string) => host.cancelDelegate(taskId));
  ipcMain.handle(IPC.liveStart, (e, req: unknown, mountId: unknown) => chats.liveStart(e.sender.id, mountId, req));
  ipcMain.handle(IPC.liveSend, (e, sessionId: unknown, text: unknown, mountId: unknown) => chats.liveSend(e.sender.id, mountId, sessionId, text));
  ipcMain.on(IPC.liveStop, (e, sessionId: unknown, mountId: unknown) => chats.liveStop(e.sender.id, mountId, sessionId));
  ipcMain.handle(IPC.liveInterrupt, (e, sessionId: unknown, mountId: unknown, turns: unknown) => chats.liveInterrupt(e.sender.id, mountId, sessionId, turns));
  ipcMain.handle(IPC.liveResume, (e, sessionId: unknown, mountId: unknown) => chats.liveResume(e.sender.id, mountId, sessionId));
  // A chat's terminals: every call names an attached mount of the chat window, plus the tab;
  // payloads and tab ids are validated in terminal-tasks. Refused fire-and-forget calls are dropped.
  ipcMain.handle(IPC.terminalStart, (e, projectPath: unknown, cols: unknown, rows: unknown, mountId: unknown, tabId: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    return key === undefined
      ? { error: "Terminals run from the chat window." }
      : deps.terminalTasks.start({ clientId: e.sender.id, mountId: key }, tabId, projectPath, cols, rows);
  });
  ipcMain.on(IPC.terminalWrite, (e, data: unknown, mountId: unknown, tabId: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.write(key, tabId, data);
  });
  ipcMain.on(IPC.terminalResize, (e, cols: unknown, rows: unknown, mountId: unknown, tabId: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.resize(key, tabId, cols, rows);
  });
  ipcMain.on(IPC.terminalAck, (e, chars: unknown, mountId: unknown, tabId: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    if (key !== undefined) deps.terminalTasks.ack(key, tabId, chars);
  });
  // No tab = every tab of the chat.
  ipcMain.handle(IPC.terminalStop, async (e, mountId: unknown, tabId?: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    if (key === undefined) return;
    await (tabId === undefined ? deps.terminalTasks.stopMount(key) : deps.terminalTasks.stop(key, tabId));
  });
  // The close cards' fresh check: what runs in this chat's terminals (or one tab's) right now.
  ipcMain.handle(IPC.terminalRunning, (e, mountId: unknown, tabId?: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    return key === undefined ? [] : deps.terminalTasks.runningCommand(key, tabId);
  });
  ipcMain.on(IPC.terminalOpenLink, (e, url: unknown, mountId: unknown) => {
    const href = chats.tryKey(e.sender.id, mountId) === undefined ? undefined : terminalLink(url);
    if (href) deps.shell.openExternal(href).catch((err: unknown) => console.error("terminal link failed:", err));
  });
  // Cmd+click on a path in the chat log (#779): validated and resolved here, never by the renderer.
  ipcMain.on(IPC.chatOpenPath, (e, raw: unknown, mountId: unknown) => {
    const key = chats.tryKey(e.sender.id, mountId);
    const abs = key === undefined ? undefined : chatPathTarget(raw, host.liveProjectOf(key), homedir());
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
  ipcMain.handle(IPC.availableClis, () => host.availableClis());
  ipcMain.handle(IPC.detectedClis, () => host.detectedClis());
  ipcMain.handle(IPC.availableModels, () => host.models());
  ipcMain.handle(IPC.getModelMemory, (_e, skillName: string) => host.modelMemory.get(skillName));
  ipcMain.handle(IPC.setModelMemory, (_e, skillName: string, modelId: string) => host.modelMemory.set(skillName, modelId));

  ipcMain.handle(IPC.getPersona, () => host.persona.get());
  ipcMain.handle(IPC.savePersona, (_e, p: Persona) => host.persona.save(p));

  const memory = host.memory;
  ipcMain.handle(IPC.listMemories, () => memory.list());
  ipcMain.handle(IPC.appendMemories, (_e, additions: Memory[]) => memory.append(additions));
  ipcMain.handle(IPC.updateMemory, (_e, id: string, text: string) => memory.update(id, text));
  ipcMain.handle(IPC.deleteMemories, (_e, ids: string[]) => memory.delete(ids));
  ipcMain.handle(IPC.updateMemoryCategory, (_e, id: string, category: string | null) => memory.updateCategory(id, category));
  ipcMain.handle(IPC.renameMemoryCategory, (_e, from: string, to: string) => memory.renameCategory(from, to));
  ipcMain.handle(IPC.memoryOwnerIds, () => memory.ownerIds());
  ipcMain.on(IPC.chatIncognito, (e, on: unknown, mountId: unknown) => chats.incognito(e.sender.id, mountId, on));
  const notChat = (): never => { throw new Error("Chat history is for the chat window."); };
  const threads = host.threads;
  ipcMain.handle(IPC.chatThreadSave, (e, req: unknown, mountId: unknown) => chats.threadSave(e.sender.id, mountId, req));
  ipcMain.handle(IPC.chatThreadGet, (e, id: unknown, mountId: unknown) => chats.threadGet(e.sender.id, mountId, id));
  ipcMain.handle(IPC.chatThreadList, (e) => deps.isChatClient(e.sender.id) ? threads.list() : notChat());
  ipcMain.handle(IPC.chatThreadDelete, (e, id: unknown) =>
    deps.isChatClient(e.sender.id) ? threads.delete(id) : notChat());
  ipcMain.handle(IPC.chatThreadStar, (e, id: unknown, starred: unknown) =>
    deps.isChatClient(e.sender.id) ? threads.star(id, starred) : notChat());
  ipcMain.handle(IPC.chatThreadRename, (e, id: unknown, title: unknown) =>
    deps.isChatClient(e.sender.id) ? threads.rename(id, title) : notChat());
  ipcMain.handle(IPC.chatThreadGroup, (e, ids: unknown, name: unknown) =>
    deps.isChatClient(e.sender.id) ? threads.group(ids, name) : notChat());
  ipcMain.handle(IPC.chatThreadGroupRename, (e, from: unknown, to: unknown) =>
    deps.isChatClient(e.sender.id) ? threads.groupRename(from, to) : notChat());
  ipcMain.handle(IPC.syncedChatList, (e) => deps.isChatClient(e.sender.id) ? deps.syncedChatHandlers.list() : notChat());
  ipcMain.handle(IPC.syncedChatGet, (e, surface: unknown, conversationId: unknown, mountId: unknown) => {
    chats.key(e.sender.id, mountId);
    return deps.syncedChatHandlers.get(surface, conversationId);
  });
  ipcMain.handle(IPC.syncedChatSend, (e, surface: unknown, conversationId: unknown, text: unknown, mountId: unknown) => {
    chats.key(e.sender.id, mountId);
    return deps.syncedChatHandlers.send(surface, conversationId, text);
  });
  ipcMain.handle(IPC.syncedChatResume, (e, surface: unknown, conversationId: unknown, mountId: unknown) => {
    chats.key(e.sender.id, mountId);
    return deps.syncedChatHandlers.resume(surface, conversationId);
  });
  // Continue in Discord: one chat (sender + attached mount), its incognito latch read here, not sent.
  ipcMain.handle(IPC.deskContinue, (e, req: unknown, mountId: unknown) => {
    const key = chats.key(e.sender.id, mountId);
    if (!deps.deskContinue) return { failed: "Continue in Discord isn't available." };
    return deps.deskContinue({ clientId: e.sender.id, mountId: key }, chats.isIncognito(key), req);
  });
  // Fire-and-forget: the chat window is already closing. A failure already raised its bubble
  // (onMemoryFailure); this only logs it.
  ipcMain.on(IPC.rememberOnClose, (e, transcript: unknown, opts: unknown) => chats.rememberOnClose(e.sender.id, transcript, opts));
  ipcMain.handle(IPC.getMemoryBatch, () => memory.batch());
  ipcMain.handle(IPC.undoMemoryBatch, () => memory.undoBatch());
  ipcMain.handle(IPC.getLastDream, () => memory.lastDream());
  ipcMain.handle(IPC.undoLastDream, () => memory.undoLastDream());
  ipcMain.handle(IPC.dreamDetails, () => memory.dreamDetails());

  const notes = host.notes;
  ipcMain.handle(IPC.listNotes, (_e, opts?: unknown) => notes.list(opts));
  ipcMain.handle(IPC.saveNote, (_e, draft: NoteDraft, images?: unknown) => notes.save(draft, images));
  ipcMain.handle(IPC.saveNoteImage, (_e, bytes: unknown) => notes.saveImage(bytes));
  ipcMain.handle(IPC.noteImage, (_e, id: unknown) => notes.image(id));
  ipcMain.handle(IPC.archiveNote, (_e, slug: unknown) => notes.archive(slug));
  ipcMain.handle(IPC.restoreNote, (_e, slug: unknown) => notes.restore(slug));
  ipcMain.handle(IPC.purgeNote, (_e, slug: unknown) => notes.purge(slug));
  // === true, not a cast: the renderer's types are erased by the time a value crosses IPC,
  // and every truthy payload ("false" included) would otherwise star the note.
  ipcMain.handle(IPC.starNote, (_e, slug: string, starred: unknown) => notes.star(slug, starred === true));
  ipcMain.handle(IPC.noteHistory, (_e, slug: string) => notes.history(slug));

  const configHandlers = buildConfigHandlers({
    getConfig: host.getConfig,
    applyConfig: host.applyConfig,
    onApplied: () => deps.push.broadcast(IPC.cliAvailabilityChanged, undefined),
  });
  ipcMain.handle(IPC.getConfig, () => configHandlers.get());
  ipcMain.handle(IPC.saveConfig, (_e, update: ConfigUpdate) => configHandlers.save(update));

  const chatopsHandlers = buildChatopsHandlers(deps);
  ipcMain.handle(IPC.chatopsStatus, () => chatopsHandlers.status());
  ipcMain.on(IPC.chatopsStart, (_e, bot: ChatopsBot) => chatopsHandlers.start(bot));
  ipcMain.on(IPC.chatopsStop, (_e, bot: ChatopsBot) => chatopsHandlers.stop(bot));
  const destinations = host.destinations;
  ipcMain.handle(IPC.destinationsList, () => destinations.list());
  ipcMain.handle(IPC.destinationsName, (_e, surface: unknown, conversationId: unknown, alias: unknown) =>
    destinations.name(surface, conversationId, alias));
  ipcMain.handle(IPC.destinationsClear, (_e, surface: unknown, conversationId: unknown) =>
    destinations.clear(surface, conversationId));
  ipcMain.handle(IPC.destinationsNameRaw, (_e, surface: unknown, conversationId: unknown, alias: unknown) =>
    destinations.nameRaw(surface, conversationId, alias));
  ipcMain.handle(IPC.sendToDestination, (e, proposalId: unknown, optionId: unknown) => {
    if (!deps.isChatClient(e.sender.id)) throw new Error("Sends are confirmed in the chat window.");
    return host.sends.send(proposalId, optionId);
  });
  ipcMain.handle(IPC.destinationsRetarget, (_e, alias: unknown, surface: unknown, conversationId: unknown) =>
    destinations.retarget(alias, surface, conversationId));


  const proposals = host.skillProposals;
  ipcMain.handle(IPC.skillProposalsList, () => proposals.list());
  ipcMain.handle(IPC.skillProposalsApprove, (_e, id: string) => proposals.approve(id));
  ipcMain.handle(IPC.skillProposalsReject, (_e, id: string) => proposals.reject(id));
  ipcMain.handle(IPC.skillProposalsUndo, (_e, id: string) => proposals.undo(id));
  const routines = host.routines;
  ipcMain.handle(IPC.routinesList, () => routines.list());
  ipcMain.handle(IPC.routinesSave, (_e, routine: Routine) => routines.save(routine));
  ipcMain.handle(IPC.routinesDelete, (_e, name: string) => routines.remove(name));
  ipcMain.handle(IPC.routinesState, () => routines.state());
  ipcMain.handle(IPC.routinesRunNow, (_e, name: string) => routines.runNow(name));
  ipcMain.handle(IPC.routineStop, (_e, name: unknown) => routines.stop(name));
  ipcMain.handle(IPC.routinesAttempts, (_e, runId: string) => routines.attempts(runId));
  ipcMain.handle(IPC.routinesCheckNow, (_e, name: string) => routines.checkNow(name));
  ipcMain.handle(IPC.routinesPreviewWatch, (_e, w: RoutineWatch) => routines.previewWatch(w));
  ipcMain.handle(IPC.routinesEnableWatch, (_e, name: string, queueExisting: boolean) => routines.enableWatch(name, queueExisting));
  ipcMain.handle(IPC.routinesSinkRecipients, () => routines.sinkRecipients());
  ipcMain.handle(IPC.routinesDraftBrief, (_e, sentence: string, previous?: RoutineBrief) => routines.draftBrief(sentence, previous));
  ipcMain.handle(IPC.routinesBuild, (_e, brief: RoutineBrief) => routines.build(brief));
  ipcMain.handle(IPC.routinesBuilds, () => routines.builds());
  ipcMain.handle(IPC.routinesCancelBuild, (_e, name: string) => routines.cancelBuild(name));
  ipcMain.handle(IPC.routinesDismissBuild, (_e, name: string) => routines.dismissBuild(name));

  const todos = host.todos;
  ipcMain.handle(IPC.todosList, (_e, routine: string) => todos.list(routine));
  ipcMain.handle(IPC.todosListAll, () => todos.listAll());
  ipcMain.handle(IPC.todosAdd, (_e, routine: string, text: string) => todos.add(routine, text));
  ipcMain.handle(IPC.todosEdit, (_e, id: string, text: string) => todos.edit(id, text));
  ipcMain.handle(IPC.todosDelete, (_e, id: string) => todos.remove(id));
  ipcMain.handle(IPC.todosReorder, (_e, id: string, newOrder: number) => todos.reorder(id, newOrder));
  ipcMain.handle(IPC.todosClearFinished, (_e, routine: string) => todos.clearFinished(routine));
  ipcMain.handle(IPC.todosRetry, (_e, id: string) => todos.retry(id));

  // Core half of a drop on a skill tile: the plan, from the host's skills and projects. The avatar
  // shows it through the shell's proposeRun.
  ipcMain.handle(IPC.planDrop, async (_e, skillName: string, droppedUrl: string) =>
    planForDroppedSkill(skillName, droppedUrl, await host.listSkills(), await host.listProjects()));
}

/** The shell's own channels: theme, updates, About, opening windows and their pull-on-mount stores. */
export function registerShellIpc(electronIpc: IpcLike, deps: ShellIpcDeps): void {
  const ipcMain = guardIpc(electronIpc, []);
  ipcMain.handle(IPC.getAppInfo, () => deps.getAppInfo());

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.push.broadcast(IPC.themeChanged, next);
  });

  const updateHandlers = buildUpdateHandlers(deps);
  ipcMain.handle(IPC.checkForUpdate, () => updateHandlers.check());
  ipcMain.handle(IPC.installUpdate, () => updateHandlers.install());
  ipcMain.on(IPC.openUpdateReleasePage, () => updateHandlers.openReleasesPage());

  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, payload?: unknown) => deps.openComponent(kind, openComponentPayload(kind, payload)));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
  ipcMain.handle(IPC.getPendingPlan, () => deps.getPendingPlan());
  ipcMain.handle(IPC.getPendingDroppedUrl, () => deps.getPendingDroppedUrl());
  ipcMain.handle(IPC.getPendingDashboardTarget, () => deps.getPendingDashboardTarget());
  ipcMain.on(IPC.runInChat, (_e, payload: ChatPromptPayload) => deps.runInChat(payload));
  ipcMain.handle(IPC.getPendingChatPrompt, () => deps.getPendingChatPrompt());
  ipcMain.handle(IPC.getPendingInterruptedRunNotices, () => deps.getPendingInterruptedRunNotices());
  ipcMain.handle(IPC.coreList, () => deps.cores.list());
  ipcMain.handle(IPC.coreAdd, (_e, host: unknown, container: unknown) => deps.cores.add(host, container));
  ipcMain.handle(IPC.coreRemove, (_e, id: unknown) => deps.cores.remove(id));
  ipcMain.on(IPC.coreSwitch, (_e, id: unknown) => deps.cores.switchTo(id));
  ipcMain.handle(IPC.coreStatus, () => deps.cores.status());
  ipcMain.on(IPC.coreTakeBack, () => deps.cores.takeBack());
  ipcMain.on(IPC.chatCloseKept, () => deps.cores.closeKept());

  // Lets a component window grow to fit its own content (e.g. About growing when an update
  // notice appears) instead of clipping it.
  ipcMain.on(IPC.resizeWindowToContent, (e, height: number) => deps.shell.fitHeight(e.sender.id, height));
}
