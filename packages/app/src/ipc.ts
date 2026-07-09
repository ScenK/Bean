import {
  route, converse, launchInTerminal, scratchDir,
  availableModels, loadModelMemory, saveModelMemory,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchSpawnFn, type CliName, type Memory, type MemoryCandidate, type ChatTurn,
  type ActionTool, type Note, type NoteDraft, type AvailableModel,
} from "@bean/core";
import { mkdir } from "node:fs/promises";
import type { RouterDeps } from "@bean/core";
import { BrowserWindow, dialog, screen, shell, type IpcMain } from "electron";
import { IPC, type Theme, type ComponentKind, type AvatarMode, type ConfigView, type ConfigUpdate, type AppInfo } from "./channels.js";
import { avatarSizeForMode, dragBloomLayout, nextAvatarBounds, type Bounds } from "./avatar-menu.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";

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
    return route(input, skills, projects, { chat: deps.chat, model: deps.getModel() });
  };
}

export interface ChatHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  loadMemories: (file: string) => Promise<Memory[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  projectSkillsDir: string;
  skillsDir: string;
  projectsFile: string;
  personaFile: string;
  projectPersonaFile: string;
  memoryFile: string;
  actions?: ActionTool[];
  delegateAvailable?: () => boolean;
}

export function buildChatHandler(deps: ChatHandlerDeps) {
  return async (req: ChatRequest): Promise<ConverseResult> => {
    const [skills, projects, persona, memories] = await Promise.all([
      deps.loadSkills(deps.projectSkillsDir, deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
      deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
      deps.loadMemories(deps.memoryFile),
    ]);
    const enabled = skills.filter((s) => s.enabled !== false);
    return converse(
      req.history, req.message, enabled, projects, persona, memories,
      { chat: deps.converse, model: deps.getModel() }, req.droppedUrl, deps.actions,
      undefined, req.linkedNote, deps.delegateAvailable?.() ?? false,
    );
  };
}

export interface ListSkillsHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  return (): Promise<Skill[]> => deps.loadSkills(deps.projectSkillsDir, deps.skillsDir);
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
    const fire = (resolved: LaunchRequest): void => {
      launchInTerminal(resolved, deps.spawnLaunch, undefined, deps.getTerminalApp?.(), deps.getEditorApp?.(), onError);
    };
    // A real projectPath (or "open" mode, which never uses one) launches synchronously exactly
    // like before this feature — only a "" (no-project) run needs the async scratch-workspace
    // detour, so existing callers/tests see no behavior change.
    if (req.projectPath || req.mode === "open") {
      fire(req);
      return;
    }
    void resolveProjectPath(req, deps).then(
      (projectPath) => fire({ ...req, projectPath }),
      (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))),
    );
  };
}

export interface ModelsHandlerDeps {
  getAvailableClis: () => CliName[];
}

export function buildModelsHandler(deps: ModelsHandlerDeps) {
  return (): AvailableModel[] => availableModels(deps.getAvailableClis());
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
  saveMemories: (file: string, memories: Memory[]) => Promise<void>;
  extractMemories: (
    transcript: ChatTurn[], existing: Memory[], projects: Project[], deps: ConverseDeps,
  ) => Promise<MemoryCandidate[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  memoryFile: string;
  projectsFile: string;
}

export function buildMemoryHandlers(deps: MemoryHandlerDeps) {
  return {
    list: (): Promise<Memory[]> => deps.loadMemories(deps.memoryFile),
    save: (memories: Memory[]): Promise<void> => deps.saveMemories(deps.memoryFile, memories),
    extract: async (transcript: ChatTurn[]): Promise<MemoryCandidate[]> => {
      const [existing, projects] = await Promise.all([
        deps.loadMemories(deps.memoryFile),
        deps.loadProjects(deps.projectsFile),
      ]);
      return deps.extractMemories(transcript, existing, projects, { chat: deps.converse, model: deps.getModel() });
    },
  };
}

export interface NotesHandlerDeps {
  loadNotes: (dir: string) => Promise<Note[]>;
  saveNote: (dir: string, draft: NoteDraft) => Promise<string>;
  deleteNote: (dir: string, slug: string) => Promise<void>;
  notesDir: string;
}

export function buildNotesHandlers(deps: NotesHandlerDeps) {
  return {
    list: (): Promise<Note[]> => deps.loadNotes(deps.notesDir),
    save: (draft: NoteDraft): Promise<string> => deps.saveNote(deps.notesDir, draft),
    delete: (slug: string): Promise<void> => deps.deleteNote(deps.notesDir, slug),
  };
}

export interface ConfigHandlerDeps {
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
}

export function buildConfigHandlers(deps: ConfigHandlerDeps) {
  return {
    get: (): ConfigView => deps.getConfig(),
    save: (update: ConfigUpdate): Promise<void> => deps.applyConfig(update),
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

export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  deleteSkill: (dir: string, name: string) => Promise<void>;
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
  loadMemories: (file: string) => Promise<Memory[]>;
  saveMemories: (file: string, memories: Memory[]) => Promise<void>;
  extractMemories: MemoryHandlerDeps["extractMemories"];
  memoryFile: string;
  loadNotes: NotesHandlerDeps["loadNotes"];
  saveNote: NotesHandlerDeps["saveNote"];
  deleteNote: NotesHandlerDeps["deleteNote"];
  notesDir: string;
  actions?: ActionTool[];
  delegateAvailable?: () => boolean;
  broadcast: (channel: string, payload: unknown) => void;
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  getPendingPlan: () => RouteSuggestion | undefined;
  getPendingDroppedUrl: () => string | undefined;
  runInChat: (payload: ChatPromptPayload) => void;
  getPendingChatPrompt: () => ChatPromptPayload | undefined;
  planFromDrop: (skillName: string, droppedUrl: string) => void;
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  getAppInfo: () => AppInfo;
  spawnLaunch?: LaunchSpawnFn;
  getTerminalApp: () => string;
  getEditorApp: () => string;
  getAvailableClis: () => CliName[];
  beanDirPath: string;
  modelMemoryFile: string;
  delegateTasks: {
    start: (req: DelegateStartRequest) => string;
    cancel: (taskId: string) => void;
  };
  onLaunchError?: (req: LaunchRequest, err: Error) => void;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));

  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, (_e, req: ChatRequest) => chatHandler(req));
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
  ipcMain.handle(IPC.saveMemories, (_e, memories: Memory[]) => memoryHandlers.save(memories));
  ipcMain.handle(IPC.extractMemories, (_e, transcript: ChatTurn[]) => memoryHandlers.extract(transcript));

  const notesHandlers = buildNotesHandlers(deps);
  ipcMain.handle(IPC.listNotes, () => notesHandlers.list());
  ipcMain.handle(IPC.saveNote, (_e, draft: NoteDraft) => notesHandlers.save(draft));
  ipcMain.handle(IPC.deleteNote, (_e, slug: string) => notesHandlers.delete(slug));

  const configHandlers = buildConfigHandlers({ getConfig: deps.getConfig, applyConfig: deps.applyConfig });
  ipcMain.handle(IPC.getConfig, () => configHandlers.get());
  ipcMain.handle(IPC.saveConfig, (_e, update: ConfigUpdate) => configHandlers.save(update));
  ipcMain.handle(IPC.getAppInfo, () => deps.getAppInfo());

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.broadcast(IPC.themeChanged, next);
  });

  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, droppedUrl?: string) => deps.openComponent(kind, droppedUrl));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
  ipcMain.handle(IPC.getPendingPlan, () => deps.getPendingPlan());
  ipcMain.handle(IPC.getPendingDroppedUrl, () => deps.getPendingDroppedUrl());
  ipcMain.on(IPC.planFromDrop, (_e, skillName: string, droppedUrl: string) => deps.planFromDrop(skillName, droppedUrl));
  ipcMain.on(IPC.runInChat, (_e, payload: ChatPromptPayload) => deps.runInChat(payload));
  ipcMain.handle(IPC.getPendingChatPrompt, () => deps.getPendingChatPrompt());

  // Avatar window growth: one shared mode (normal/menu/drag) drives its bounds. The bubble
  // menu grows symmetrically (centered on the bean). The drag bloom instead anchors on the
  // bean's fixed screen center and clamps the window to the work area, so growing near a screen
  // corner shifts the window — never the bean (see dragBloomLayout). We remember that anchor to
  // recenter the small window when the bloom closes.
  let dragAnchor: { x: number; y: number } | undefined;
  let menuAnchor: { x: number; y: number } | undefined;

  // Manual drag-to-move for the avatar: the visible #bean element is deliberately
  // -webkit-app-region: no-drag (see .memory/safety-window-behavior.md), so moving
  // it is done via mouse deltas from the renderer instead of the CSS drag region.
  ipcMain.on(IPC.moveWindowBy, (e, dx: number, dy: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const [x = 0, y = 0] = win.getPosition();
    win.setPosition(x + dx, y + dy);
    // Moving while a box/bloom is open (the common case — proximity-hover opens on approach, so
    // the user is usually dragging the expanded box): keep the collapse anchor in sync with the
    // move, otherwise closing the box would snap the bean back to where it was grabbed.
    if (dragAnchor) dragAnchor = { x: dragAnchor.x + dx, y: dragAnchor.y + dy };
    if (menuAnchor) menuAnchor = { x: menuAnchor.x + dx, y: menuAnchor.y + dy };
  });
  let menuPoll: ReturnType<typeof setInterval> | undefined;
  let menuOutsideSince: number | undefined;
  const stopMenuPoll = (): void => {
    if (menuPoll) clearInterval(menuPoll);
    menuPoll = undefined;
    menuOutsideSince = undefined;
  };
  // Polls the cursor and asks the renderer to fold once it's been outside the window for `foldMs`.
  // The click menu folds lazily (2s); the hover box folds promptly (backstop for the renderer's
  // mouseleave, which on this transparent always-on-top window sometimes never fires).
  const startMenuPoll = (win: BrowserWindow, foldMs: number): void => {
    stopMenuPoll();
    menuPoll = setInterval(() => {
      if (win.isDestroyed()) { stopMenuPoll(); return; }
      const bounds = win.getBounds();
      const point = screen.getCursorScreenPoint();
      const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
      if (inside) { menuOutsideSince = undefined; return; }
      menuOutsideSince ??= Date.now();
      if (Date.now() - menuOutsideSince < foldMs) return;
      win.webContents.send(IPC.avatarFoldMenu);
      stopMenuPoll();
    }, 120);
  };
  ipcMain.on(IPC.setAvatarMode, (e, mode: AvatarMode) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    // The click menu auto-folds lazily; the hover box folds promptly (backstop for a dropped
    // mouseleave). Grown-tile / idle modes don't poll.
    if (mode === "menu") startMenuPoll(win, 2000);
    else if (mode === "hover") startMenuPoll(win, 100);
    else stopMenuPoll();
    const cur = win.getBounds();
    let target: Bounds;
    if (mode === "drag" || mode === "menu" || mode === "hover") {
      // Anchor on the bean's fixed screen center so it never jumps as the box + tiles grow.
      // Reuse an existing anchor when we're already grown (hover→menu, menu→drag, …): in a grown
      // window the bean sits at the top-right, NOT the window center, so recomputing from the center
      // would mis-anchor and make the bean jump left. Only when growing fresh from the idle window
      // (no anchor yet) is the window center the bean's true position.
      const beanCenter = dragAnchor ?? menuAnchor ?? { x: cur.x + Math.round(cur.width / 2), y: cur.y + Math.round(cur.height / 2) };
      if (mode === "drag") dragAnchor = beanCenter;
      else menuAnchor = beanCenter;
      const workArea = screen.getDisplayMatching(cur).workArea;
      const layout = dragBloomLayout(beanCenter, avatarSizeForMode(mode), workArea);
      target = layout.bounds;
      win.webContents.send(IPC.avatarDragLayout, layout.bean);
    } else if (mode === "normal" && (dragAnchor || menuAnchor)) {
      const anchor = dragAnchor ?? menuAnchor!;
      const size = avatarSizeForMode("normal");
      target = { x: anchor.x - Math.round(size.width / 2), y: anchor.y - Math.round(size.height / 2), width: size.width, height: size.height };
      dragAnchor = undefined;
      menuAnchor = undefined;
    } else {
      target = nextAvatarBounds(cur, avatarSizeForMode(mode));
    }
    if (target.width === cur.width && target.height === cur.height && target.x === cur.x && target.y === cur.y) return;
    win.setBounds(target);
    // Idle centers the bean in the small (120x120) window; tell the renderer that center so it
    // re-pins the (collapsed) box to the exact same screen point — the window resized but the bean
    // must not move (see onAvatarDragLayout "normal").
    if (mode === "normal") win.webContents.send(IPC.avatarDragLayout, { x: Math.round(target.width / 2), y: Math.round(target.height / 2) });
  });
}
