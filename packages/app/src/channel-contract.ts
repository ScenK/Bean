import { argsOk, guard as g, type Capability, type Guard } from "@bean/host";
import { IPC } from "./channels.js";

/** Who owns a channel (#807) — the one table a shell and a host agree on:
 * - `core` — the host's own work (chats, memory, notes, routines, config, bots); runs on any host.
 * - `host-bound` — needs the host machine's desktop, named by the capability the host must offer.
 * - `shell` — the shell's own windows, theme, updates and open-this-window stores; never leaves it.
 * `args` are the call's arguments (invoke/send) or, for a push, its one payload. Core and host-bound
 * payloads are checked against them before a handler runs (`guardIpc`) and before a push is delivered
 * (`createPush`). A channel whose handler did both host and shell work would be split, not classified
 * twice; the chat-mount checks (`chats.key`) are authorization, not shell work. */
export type ChannelContract =
  | { owner: "core"; args: readonly Guard[] }
  | { owner: "host-bound"; needs: Capability; args: readonly Guard[] }
  | { owner: "shell" };

const { str, num, bool, none, bytes, obj, arr, opt, nullable, oneOf } = g;
const core = (...args: Guard[]): ChannelContract => ({ owner: "core", args });
const bound = (needs: Capability, ...args: Guard[]): ChannelContract => ({ owner: "host-bound", needs, args });
const shell: ChannelContract = { owner: "shell" };
const bot = oneOf("discord", "teams");

export const CHANNEL_CONTRACT = {
  handshake: core(),
  launch: bound("terminalHandoff", obj),
  delegateStart: core(obj, str),
  delegateCancel: core(str),
  delegateEvent: core(obj),
  liveStart: core(obj, str),
  liveSend: core(str, str, str),
  liveStop: core(str, str),
  liveInterrupt: core(str, str, num),
  liveResume: core(str, str),
  liveEvent: core(obj),
  terminalStart: bound("pty", str, num, num, str, str),
  terminalWrite: bound("pty", str, str, str),
  terminalResize: bound("pty", num, num, str, str),
  terminalAck: bound("pty", num, str, str),
  terminalStop: bound("pty", str, opt(str)),
  terminalRunning: bound("pty", str, opt(str)),
  terminalOpenLink: bound("pty", str, str),
  chatOpenPath: bound("pathOpen", str, str),
  terminalEvent: bound("pty", obj),
  availableClis: core(),
  detectedClis: core(),
  availableModels: core(),
  cliAvailabilityChanged: core(none),
  getModelMemory: core(str),
  setModelMemory: core(str, str),
  chat: core(obj, str),
  chatStop: core(str, str),
  chatImageProgress: core(str),
  chatStageImage: core(str, str, str),
  listSkills: core(),
  listProjects: core(),
  saveProjects: core(arr(obj)),
  pickProjectFolder: bound("pathOpen"),
  pickTerminalApp: bound("pathOpen"),
  pickEditorApp: bound("pathOpen"),
  revealInFinder: bound("pathOpen", str),
  saveSkill: core(str, str),
  deleteSkill: core(str),
  getPersona: core(),
  savePersona: core(obj),
  getModel: core(),
  getTheme: shell,
  setTheme: shell,
  themeChanged: shell,
  openComponent: shell,
  componentDroppedUrl: shell,
  getPendingDroppedUrl: shell,
  dashboardTarget: shell,
  getPendingDashboardTarget: shell,
  proposeRun: shell,
  getPendingPlan: shell,
  moveWindowBy: shell,
  resizeWindowToContent: shell,
  setAvatarMode: shell,
  avatarFoldMenu: shell,
  avatarReset: shell,
  avatarDragLayout: shell,
  setAvatarStatusHeight: shell,
  taskStatus: core(arr(obj)),
  dismissTask: core(str),
  openChatMount: shell,
  showChatMount: shell,
  planFromDrop: shell,
  getConfig: core(),
  saveConfig: core(obj),
  getAppInfo: shell,
  quit: shell,
  runInChat: shell,
  chatPrompt: shell,
  getPendingChatPrompt: shell,
  interruptedRunNotice: shell,
  getPendingInterruptedRunNotices: shell,
  listNotes: core(opt(obj)),
  saveNote: core(obj, opt(arr(obj))),
  archiveNote: core(str),
  restoreNote: core(str),
  purgeNote: core(str),
  starNote: core(str, bool),
  noteHistory: core(str),
  saveNoteImage: core(bytes),
  noteImage: core(str),
  listMemories: core(),
  appendMemories: core(arr(obj)),
  updateMemory: core(str, str),
  deleteMemories: core(arr(str)),
  updateMemoryCategory: core(str, nullable(str)),
  renameMemoryCategory: core(str, str),
  memoryOwnerIds: core(),
  rememberOnClose: core(arr(obj), obj),
  memoryUpdated: core(obj),
  chatAttach: core(str),
  chatRelease: core(str),
  chatIncognito: core(bool, str),
  chatThreadSave: core(obj, str),
  chatThreadGet: core(str, str),
  chatThreadList: core(),
  chatThreadDelete: core(str),
  chatThreadStar: core(str, bool),
  chatThreadRename: core(str, str),
  chatThreadGroup: core(arr(str), nullable(str)),
  chatThreadGroupRename: core(str, str),
  syncedChatList: core(),
  syncedChatGet: core(str, str, str),
  syncedChatSend: core(str, str, str, str),
  syncedChatResume: core(str, str, str),
  syncedChatEvent: core(obj),
  deskContinue: core(obj, str),
  getMemoryBatch: core(),
  undoMemoryBatch: core(),
  getLastDream: core(),
  undoLastDream: core(),
  dreamDetails: core(),
  reviewBeforeClose: shell,
  allowChatClose: shell,
  chatopsStatus: core(),
  chatopsStart: core(bot),
  chatopsStop: core(bot),
  chatopsEvent: core(obj),
  destinationsList: core(),
  destinationsName: core(str, str, str),
  destinationsClear: core(str, str),
  destinationsRetarget: core(str, str, str),
  destinationsNameRaw: core(str, str, str),
  sendToDestination: core(str, str),
  skillProposalsList: core(),
  skillProposalsApprove: core(str),
  skillProposalsReject: core(str),
  skillProposalsUndo: core(str),
  routinesList: core(),
  routinesSave: core(obj),
  routinesDelete: core(str),
  routinesRunNow: core(str),
  routineStop: core(str),
  routinesState: core(),
  routinesAttempts: core(str),
  routinesCheckNow: core(str),
  routinesPreviewWatch: core(obj),
  routinesEnableWatch: core(str, bool),
  routinesSinkRecipients: core(),
  routinesDraftBrief: core(str, opt(obj)),
  routinesBuild: core(obj),
  routinesBuilds: core(),
  routinesCancelBuild: core(str),
  routinesDismissBuild: core(str),
  todosList: core(str),
  todosListAll: core(),
  todosAdd: core(str, str),
  todosEdit: core(str, str),
  todosDelete: core(str),
  todosReorder: core(str, num),
  todosClearFinished: core(str),
  todosRetry: core(str),
  checkForUpdate: shell,
  installUpdate: shell,
  openUpdateReleasePage: shell,
} satisfies Record<keyof typeof IPC, ChannelContract>;

const BY_CHANNEL = new Map<string, ChannelContract>(
  Object.entries(CHANNEL_CONTRACT).map(([k, c]) => [IPC[k as keyof typeof IPC], c]),
);

/** Why a call (or a push's payload) breaks the contract; undefined = let it through. */
export function contractRefusal(channel: string, args: readonly unknown[], capabilities: readonly Capability[]): string | undefined {
  const c = BY_CHANNEL.get(channel);
  if (!c) return `${channel} is not in the contract`;
  if (c.owner === "shell") return undefined;
  if (c.owner === "host-bound" && !capabilities.includes(c.needs)) return `${channel} needs the host's ${c.needs} capability`;
  return argsOk(c.args, args) ? undefined : `malformed payload on ${channel}`;
}

// `any[]`: the handlers declare their own (unchecked until here) parameter types, as Electron's do.
type Listener = (e: { sender: { id: number } }, ...args: any[]) => unknown;
export interface IpcLike {
  handle: (channel: string, fn: Listener) => void;
  on: (channel: string, fn: Listener) => void;
}

/** The Electron adapter's door: every call is checked against the contract before its handler runs —
 * a refused invoke rejects, a refused send is dropped. */
export function guardIpc(ipc: IpcLike, capabilities: readonly Capability[]): IpcLike {
  const wrap = (channel: string, fn: Listener, refuse: (why: string) => undefined): Listener => (e, ...args) => {
    const why = contractRefusal(channel, args, capabilities);
    return why === undefined ? fn(e, ...args) : refuse(why);
  };
  return {
    handle: (channel, fn) => ipc.handle(channel, wrap(channel, fn, (why) => { throw new Error(`Bean refused the call: ${why}.`); })),
    on: (channel, fn) => ipc.on(channel, wrap(channel, fn, (why) => { console.warn(`bean: dropped — ${why}`); return undefined; })),
  };
}
