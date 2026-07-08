import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC, type Theme, type ComponentKind, type AvatarMode, type ConfigView, type ConfigUpdate, type AppInfo } from "./channels.js";
import type {
  RouteInput, RouteSuggestion, ChatRequest, ConverseResult, Skill, Project, Persona, LaunchRequest, CliName,
  Memory, MemoryCandidate, ChatTurn, Note, NoteDraft, AvailableModel, UrlKind,
} from "@bean/core";
import type { DelegateEvent, DelegateStartRequest } from "./delegate-tasks.js";

contextBridge.exposeInMainWorld("bean", {
  route: (input: RouteInput): Promise<RouteSuggestion> => ipcRenderer.invoke(IPC.route, input),
  launch: (req: LaunchRequest): void => ipcRenderer.send(IPC.launch, req),
  delegateStart: (req: DelegateStartRequest): Promise<string> => ipcRenderer.invoke(IPC.delegateStart, req),
  delegateCancel: (taskId: string): void => ipcRenderer.send(IPC.delegateCancel, taskId),
  onDelegateEvent: (cb: (e: DelegateEvent) => void) =>
    ipcRenderer.on(IPC.delegateEvent, (_e, ev: DelegateEvent) => cb(ev)),
  availableClis: (): Promise<CliName[]> => ipcRenderer.invoke(IPC.availableClis),
  availableModels: (): Promise<AvailableModel[]> => ipcRenderer.invoke(IPC.availableModels),
  getModelMemory: (skillName: string): Promise<string | undefined> => ipcRenderer.invoke(IPC.getModelMemory, skillName),
  setModelMemory: (skillName: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.setModelMemory, skillName, modelId),
  sniffUrl: (url: string): Promise<UrlKind> => ipcRenderer.invoke(IPC.sniffUrl, url),
  chat: (req: ChatRequest): Promise<ConverseResult> => ipcRenderer.invoke(IPC.chat, req),
  getModel: (): Promise<string> => ipcRenderer.invoke(IPC.getModel),
  // File/folder drags (Finder) populate dataTransfer.files, not text/uri-list — this is the
  // only way to recover an absolute path from a dropped File since Electron 32 (File.path was
  // removed). Runs entirely in the preload context, no IPC round-trip needed.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  getTheme: (): Promise<Theme> => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (t: Theme): Promise<void> => ipcRenderer.invoke(IPC.setTheme, t),
  onThemeChanged: (cb: (t: Theme) => void) =>
    ipcRenderer.on(IPC.themeChanged, (_e, t: Theme) => cb(t)),
  openComponent: (kind: ComponentKind, droppedUrl?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.openComponent, kind, droppedUrl),
  onComponentDroppedUrl: (cb: (url: string) => void) =>
    ipcRenderer.on(IPC.componentDroppedUrl, (_e, url: string) => cb(url)),
  getPendingDroppedUrl: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.getPendingDroppedUrl),
  proposeRun: (suggestion: RouteSuggestion): void => ipcRenderer.send(IPC.proposeRun, suggestion),
  getPendingPlan: (): Promise<RouteSuggestion | undefined> => ipcRenderer.invoke(IPC.getPendingPlan),
  onProposeRun: (cb: (suggestion: RouteSuggestion) => void) =>
    ipcRenderer.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => cb(suggestion)),
  moveWindowBy: (dx: number, dy: number): void => ipcRenderer.send(IPC.moveWindowBy, dx, dy),
  setAvatarMode: (mode: AvatarMode): void => ipcRenderer.send(IPC.setAvatarMode, mode),
  onAvatarFoldMenu: (cb: () => void) =>
    ipcRenderer.on(IPC.avatarFoldMenu, () => cb()),
  onAvatarDragLayout: (cb: (p: { x: number; y: number }) => void) =>
    ipcRenderer.on(IPC.avatarDragLayout, (_e, p: { x: number; y: number }) => cb(p)),
  planFromDrop: (skillName: string, droppedUrl: string): void =>
    ipcRenderer.send(IPC.planFromDrop, skillName, droppedUrl),
  runInChat: (prompt: string, label: string, noteSlug?: string): void =>
    ipcRenderer.send(IPC.runInChat, { prompt, label, noteSlug }),
  getPendingChatPrompt: (): Promise<{ prompt: string; label: string; noteSlug?: string } | undefined> =>
    ipcRenderer.invoke(IPC.getPendingChatPrompt),
  onChatPrompt: (cb: (p: { prompt: string; label: string; noteSlug?: string }) => void) =>
    ipcRenderer.on(IPC.chatPrompt, (_e, p: { prompt: string; label: string; noteSlug?: string }) => cb(p)),
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC.listSkills),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.listProjects),
  saveProjects: (projects: Project[]): Promise<void> => ipcRenderer.invoke(IPC.saveProjects, projects),
  pickProjectFolder: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickProjectFolder),
  pickTerminalApp: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickTerminalApp),
  pickEditorApp: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickEditorApp),
  revealInFinder: (path: string): void => ipcRenderer.send(IPC.revealInFinder, path),
  saveSkill: (name: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.saveSkill, name, body),
  deleteSkill: (name: string): Promise<void> => ipcRenderer.invoke(IPC.deleteSkill, name),
  getPersona: (): Promise<Persona> => ipcRenderer.invoke(IPC.getPersona),
  savePersona: (p: Persona): Promise<void> => ipcRenderer.invoke(IPC.savePersona, p),
  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: (update: ConfigUpdate): Promise<void> => ipcRenderer.invoke(IPC.saveConfig, update),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.getAppInfo),
  quitApp: (): void => ipcRenderer.send(IPC.quit),
  listNotes: (): Promise<Note[]> => ipcRenderer.invoke(IPC.listNotes),
  saveNote: (draft: NoteDraft): Promise<string> => ipcRenderer.invoke(IPC.saveNote, draft),
  deleteNote: (slug: string): Promise<void> => ipcRenderer.invoke(IPC.deleteNote, slug),
  listMemories: (): Promise<Memory[]> => ipcRenderer.invoke(IPC.listMemories),
  saveMemories: (memories: Memory[]): Promise<void> => ipcRenderer.invoke(IPC.saveMemories, memories),
  extractMemories: (transcript: ChatTurn[]): Promise<MemoryCandidate[]> =>
    ipcRenderer.invoke(IPC.extractMemories, transcript),
  onReviewBeforeClose: (cb: () => void) => ipcRenderer.on(IPC.reviewBeforeClose, () => cb()),
  allowChatClose: (): void => ipcRenderer.send(IPC.allowChatClose),
});
