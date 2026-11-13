export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "notes" | "plan" | "settings" | "about" | "routines" | "dashboard" | "cores";
/** Windows that need no core: with none attached, every other kind opens the Add a core panel instead. */
export const SHELL_ONLY_KINDS: readonly ComponentKind[] = ["about", "cores"];

/** The one error every core operation rejects with while no core is attached (#810). Electron wraps an
 * invoke's error ("Error invoking remote method …: Error: <message>"), so renderers match it with
 * `isNoCore`, not equality. */
export const NO_CORE = "No core attached";
export const isNoCore = (err: unknown): boolean => err instanceof Error && err.message.includes(NO_CORE);

/** Which core the shell is attached to, and how that attachment is doing (#811). Remote states:
 * `connecting` (first attach), `attached`, `reconnecting` (lost; retrying — the composer is read-only),
 * `revoked` (another machine took the core over; no automatic reconnect), `mismatch` (contract version
 * differs; blocking). `message` is the last ssh error; `command` the one-time setup to run in a terminal. */
export type CoreStatus =
  | { kind: "local" }
  | { kind: "none" }
  | { kind: "remote"; host: string; state: "connecting" | "attached" | "reconnecting" | "revoked" | "mismatch"; message?: string; command?: string };
/** How a core switch ended: the app restarts, or the panel can offer the cores again. */
export type CoreSwitchOutcome = "restarting" | "kept" | "refused" | "failed";
/** The Cores panel's list: the saved remote cores, which one is selected, and whether this machine can
 * run its own core. */
export interface CoreListing {
  selected: string | null;
  cores: Array<{ id: string; label: string }>;
  canUseLocal: boolean;
}
export type AvatarMode = "normal" | "hover" | "menu" | "drag";
/** A run to open in the Dashboard: routine + its run record's `startedAt` (absent = the routine's
 * latest recorded run — the run itself wasn't recorded). */
export interface DashboardTarget { routine: string; startedAt?: string }
/** An image or PDF file dropped on the avatar, forwarded to chat. `data` (base64) is absent when the
 * avatar didn't read it — unattachable, so the chat only needs type/size to say why. */
export interface DroppedImage { path: string; mimeType: string; size: number; data?: string }
/** What a drop on the avatar hands the chat: a path/URL as text, or image/PDF files to attach. */
export type ChatDrop = string | DroppedImage[];

export type { ConfigView, ConfigUpdate } from "@bean/host";
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
  // The service contract (channel-contract.ts): contract version, core version, platform, capabilities.
  handshake: "bean:handshake",
  launch: "bean:launch",
  delegateStart: "bean:delegate-start",
  delegateCancel: "bean:delegate-cancel",
  delegateEvent: "bean:delegate-event",
  liveStart: "bean:live-start",
  liveSend: "bean:live-send",
  liveStop: "bean:live-stop",
  liveInterrupt: "bean:live-interrupt",
  liveResume: "bean:live-resume",
  liveEvent: "bean:live-event",
  // chat window ⇄ main: the chat's own terminal (terminal-tasks.ts), mount-tagged both ways.
  terminalStart: "bean:terminal-start",
  terminalWrite: "bean:terminal-write",
  terminalResize: "bean:terminal-resize",
  terminalAck: "bean:terminal-ack",
  terminalStop: "bean:terminal-stop",
  terminalRunning: "bean:terminal-running",
  terminalOpenLink: "bean:terminal-open-link",
  chatOpenPath: "bean:chat-open-path",
  terminalEvent: "bean:terminal-event",
  availableClis: "bean:available-clis",
  detectedClis: "bean:detected-clis",
  availableModels: "bean:available-models",
  cliAvailabilityChanged: "bean:cli-availability-changed",
  getModelMemory: "bean:get-model-memory",
  setModelMemory: "bean:set-model-memory",
  chat: "bean:chat",
  // chat window → main: Stop / Esc Esc for Bean's own running turn (that mount + turnId only).
  chatStop: "bean:chat-stop",
  chatImageProgress: "bean:chat-image-progress",
  chatStageImage: "bean:chat-stage-image",
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
  dashboardTarget: "bean:dashboard-target",
  getPendingDashboardTarget: "bean:get-pending-dashboard-target",
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
  openChatMount: "bean:open-chat-mount",
  showChatMount: "bean:show-chat-mount",
  // avatar → main: the plan for a skill tile a URL was dropped on (shown via proposeRun).
  planDrop: "bean:plan-drop",
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
  archiveNote: "bean:archive-note",
  restoreNote: "bean:restore-note",
  purgeNote: "bean:purge-note",
  starNote: "bean:star-note",
  noteHistory: "bean:note-history",
  saveNoteImage: "bean:save-note-image",
  noteImage: "bean:note-image",
  listMemories: "bean:list-memories",
  appendMemories: "bean:append-memories",
  updateMemory: "bean:update-memory",
  deleteMemories: "bean:delete-memories",
  updateMemoryCategory: "bean:update-memory-category",
  renameMemoryCategory: "bean:rename-memory-category",
  memoryOwnerIds: "bean:memory-owner-ids",
  rememberOnClose: "bean:remember-on-close",
  // main → chat window: a per-turn capture saved these facts (the Undo receipt row).
  memoryUpdated: "bean:memory-updated",
  // chat window → main: a chat session (mount id) starts/ends inside the window; per-chat requests
  // name an attached mount (ipc.ts buildChatMounts).
  chatAttach: "bean:chat-attach",
  chatRelease: "bean:chat-release",
  // chat window → main: its 🕶 chip changed (gates per-turn capture already in flight).
  chatIncognito: "bean:chat-incognito",
  // chat window → main: write-through of a chat's transcript (desktop chat history), and the thread
  // a chat picked in the sidebar restores.
  chatThreadSave: "bean:chat-thread-save",
  chatThreadGet: "bean:chat-thread-get",
  // chat window's history sidebar → main: list/delete/star/rename/group saved threads.
  chatThreadList: "bean:chat-thread-list",
  chatThreadDelete: "bean:chat-thread-delete",
  chatThreadStar: "bean:chat-thread-star",
  chatThreadRename: "bean:chat-thread-rename",
  chatThreadGroup: "bean:chat-thread-group",
  chatThreadGroupRename: "bean:chat-thread-group-rename",
  // chat window ⇄ main: the owner's Discord/Teams conversations in the sidebar (synced-chats.ts) —
  // list, one transcript, a desk turn, Continue live; main pushes `syncedChatEvent` when one changes.
  syncedChatList: "bean:synced-chat-list",
  syncedChatGet: "bean:synced-chat-get",
  syncedChatSend: "bean:synced-chat-send",
  syncedChatResume: "bean:synced-chat-resume",
  syncedChatEvent: "bean:synced-chat-event",
  // chat window → main: Continue in Discord (desk-continue.ts) — open a thread and move this chat there.
  deskContinue: "bean:desk-continue",
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
  // Settings → ChatOps → Destinations (destinations.ts): list seen conversations, name/clear/retarget aliases.
  destinationsList: "bean:destinations-list",
  destinationsName: "bean:destinations-name",
  destinationsClear: "bean:destinations-clear",
  destinationsRetarget: "bean:destinations-retarget",
  destinationsNameRaw: "bean:destinations-name-raw",
  // propose_send card (#688): the proposal id + the picked option id; main holds the body and rows.
  sendToDestination: "bean:send-to-destination",
  skillProposalsList: "bean:skill-proposals-list",
  skillProposalsApprove: "bean:skill-proposals-approve",
  skillProposalsReject: "bean:skill-proposals-reject",
  skillProposalsUndo: "bean:skill-proposals-undo",
  routinesList: "bean:routines-list",
  routinesSave: "bean:routines-save",
  routinesDelete: "bean:routines-delete",
  routinesRunNow: "bean:routines-run-now",
  routineStop: "bean:routine-stop",
  routinesState: "bean:routines-state",
  routinesAttempts: "bean:routines-attempts",
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
  // Cores panel / tray (#811): the saved cores, add/remove one, and switch (saved to userData, then Bean
  // restarts — after the chat window's Keep/Stop review). "local" = the core on this Mac.
  coreList: "bean:core-list",
  coreAdd: "bean:core-add",
  coreRemove: "bean:core-remove",
  coreSwitch: "bean:core-switch",
  // The attachment's state (host badge, reconnect bar, takeover and version banners), pulled + pushed.
  coreStatus: "bean:core-status",
  coreStatusChanged: "bean:core-status-changed",
  // "Take back" after another machine took the core over.
  coreTakeBack: "bean:core-take-back",
  // Chat → main: the Keep/Stop card's "Keep working" — a close waiting on it (a core switch, a quit) is off.
  chatCloseKept: "bean:chat-close-kept",
} as const;
