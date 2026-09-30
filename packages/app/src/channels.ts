export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "notes" | "plan" | "settings" | "about" | "routines" | "dashboard";
export type AvatarMode = "normal" | "hover" | "menu" | "drag";

export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  systemControls: boolean;
  reasoningEffort: string;
  routineDigestContext: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  systemControls: boolean;
  reasoningEffort: string;
  routineDigestContext: boolean;
  disabledClis: string[];
  webSearch: boolean;
  autoMemory: boolean;
}
export interface AppInfo {
  version: string;
  author: string;
  description: string;
  isPackaged: boolean;
}

export type UpdateStatus =
  | { status: "up-to-date" }
  | { status: "available"; version: string; notes: string }
  | { status: "error"; message: string };

export interface InstallUpdateResult { status: "error"; message: string }

export const IPC = {
  route: "bean:route",
  launch: "bean:launch",
  delegateStart: "bean:delegate-start",
  delegateCancel: "bean:delegate-cancel",
  delegateEvent: "bean:delegate-event",
  availableClis: "bean:available-clis",
  detectedClis: "bean:detected-clis",
  availableModels: "bean:available-models",
  cliAvailabilityChanged: "bean:cli-availability-changed",
  getModelMemory: "bean:get-model-memory",
  setModelMemory: "bean:set-model-memory",
  chat: "bean:chat",
  chatImageProgress: "bean:chat-image-progress",
  listSkills: "bean:list-skills",
  listProjects: "bean:list-projects",
  saveProjects: "bean:save-projects",
  pickProjectFolder: "bean:pick-project-folder",
  pickTerminalApp: "bean:pick-terminal-app",
  pickEditorApp: "bean:pick-editor-app",
  revealInFinder: "bean:reveal-in-finder",
  saveSkill: "bean:save-skill",
  deleteSkill: "bean:delete-skill",
  getPersona: "bean:get-persona",
  savePersona: "bean:save-persona",
  getModel: "bean:get-model",
  getTheme: "bean:get-theme",
  setTheme: "bean:set-theme",
  themeChanged: "bean:theme-changed",
  openComponent: "bean:open-component",
  componentDroppedUrl: "bean:component-dropped-url",
  getPendingDroppedUrl: "bean:get-pending-dropped-url",
  proposeRun: "bean:propose-run",
  getPendingPlan: "bean:get-pending-plan",
  moveWindowBy: "bean:move-window-by",
  resizeWindowToContent: "bean:resize-window-to-content",
  setAvatarMode: "bean:set-avatar-mode",
  avatarFoldMenu: "bean:avatar-fold-menu",
  avatarReset: "bean:avatar-reset",
  avatarDragLayout: "bean:avatar-drag-layout",
  setAvatarStatusHeight: "bean:set-avatar-status-height",
  taskStatus: "bean:task-status",
  dismissTask: "bean:dismiss-task",
  planFromDrop: "bean:plan-from-drop",
  getConfig: "bean:get-config",
  saveConfig: "bean:save-config",
  getAppInfo: "bean:get-app-info",
  quit: "bean:quit",
  runInChat: "bean:run-in-chat",
  chatPrompt: "bean:chat-prompt",
  getPendingChatPrompt: "bean:get-pending-chat-prompt",
  interruptedRunNotice: "bean:interrupted-run-notice",
  getPendingInterruptedRunNotices: "bean:get-pending-interrupted-run-notices",
  listNotes: "bean:list-notes",
  saveNote: "bean:save-note",
  deleteNote: "bean:delete-note",
  starNote: "bean:star-note",
  noteHistory: "bean:note-history",
  saveNoteImage: "bean:save-note-image",
  noteImage: "bean:note-image",
  listMemories: "bean:list-memories",
  appendMemories: "bean:append-memories",
  updateMemory: "bean:update-memory",
  deleteMemories: "bean:delete-memories",
  rememberOnClose: "bean:remember-on-close",
  getMemoryBatch: "bean:get-memory-batch",
  undoMemoryBatch: "bean:undo-memory-batch",
  getLastDream: "bean:get-last-dream",
  undoLastDream: "bean:undo-last-dream",
  dreamDetails: "bean:dream-details",
  reviewBeforeClose: "bean:review-before-close",
  allowChatClose: "bean:allow-chat-close",
  chatopsStatus: "bean:chatops-status",
  chatopsStart: "bean:chatops-start",
  chatopsStop: "bean:chatops-stop",
  chatopsEvent: "bean:chatops-event",
  routinesList: "bean:routines-list",
  routinesSave: "bean:routines-save",
  routinesDelete: "bean:routines-delete",
  routinesRunNow: "bean:routines-run-now",
  routinesState: "bean:routines-state",
  routinesCheckNow: "bean:routines-check-now",
  routinesPreviewWatch: "bean:routines-preview-watch",
  routinesEnableWatch: "bean:routines-enable-watch",
  routinesSinkRecipients: "bean:routines-sink-recipients",
  routinesDraftBrief: "bean:routines-draft-brief",
  routinesBuild: "bean:routines-build",
  routinesBuilds: "bean:routines-builds",
  routinesCancelBuild: "bean:routines-cancel-build",
  routinesDismissBuild: "bean:routines-dismiss-build",
  todosList: "bean:todos-list",
  todosListAll: "bean:todos-list-all",
  todosAdd: "bean:todos-add",
  todosEdit: "bean:todos-edit",
  todosDelete: "bean:todos-delete",
  todosReorder: "bean:todos-reorder",
  todosClearFinished: "bean:todos-clear-finished",
  todosRetry: "bean:todos-retry",
  checkForUpdate: "bean:check-for-update",
  installUpdate: "bean:install-update",
  openUpdateReleasePage: "bean:open-update-release-page",
} as const;
