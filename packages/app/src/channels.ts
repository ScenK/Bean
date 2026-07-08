export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "notes" | "plan" | "settings" | "about";
export type AvatarMode = "normal" | "hover" | "menu" | "drag";

export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  editorApp: string;
  delegateCli: string;
}
export interface AppInfo {
  version: string;
  author: string;
  description: string;
}

export const IPC = {
  route: "bean:route",
  launch: "bean:launch",
  delegateStart: "bean:delegate-start",
  delegateCancel: "bean:delegate-cancel",
  delegateEvent: "bean:delegate-event",
  availableClis: "bean:available-clis",
  availableModels: "bean:available-models",
  getModelMemory: "bean:get-model-memory",
  setModelMemory: "bean:set-model-memory",
  chat: "bean:chat",
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
  setAvatarMode: "bean:set-avatar-mode",
  avatarFoldMenu: "bean:avatar-fold-menu",
  avatarDragLayout: "bean:avatar-drag-layout",
  planFromDrop: "bean:plan-from-drop",
  getConfig: "bean:get-config",
  saveConfig: "bean:save-config",
  getAppInfo: "bean:get-app-info",
  quit: "bean:quit",
  runInChat: "bean:run-in-chat",
  chatPrompt: "bean:chat-prompt",
  getPendingChatPrompt: "bean:get-pending-chat-prompt",
  listNotes: "bean:list-notes",
  saveNote: "bean:save-note",
  deleteNote: "bean:delete-note",
  listMemories: "bean:list-memories",
  saveMemories: "bean:save-memories",
  extractMemories: "bean:extract-memories",
  reviewBeforeClose: "bean:review-before-close",
  allowChatClose: "bean:allow-chat-close",
} as const;
