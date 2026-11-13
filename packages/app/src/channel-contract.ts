import { argsOk, guard as g, type Capability, type Guard } from "@bean/host";
import { IPC, NO_CORE } from "./channels.js";

/** Who owns a channel (#807) — the one table a shell and a host agree on:
 * - `core` — the host's own work (chats, memory, notes, routines, config, bots); runs on any host.
 * - `host-bound` — needs the host machine's desktop, named by the capability the host must offer.
 * - `shell` — the shell's own windows, theme, updates and open-this-window stores; never leaves it.
 * `args` are the call's arguments (invoke/send) or, for a push, its one payload. Core and host-bound
 * payloads are checked against them before a handler runs (`guardIpc`) and before a push is delivered
 * (`createPush`): object payloads by their required fields' types (`shape`), not just "an object". A channel whose handler did both host and shell work would be split, not classified
 * twice; the chat-mount checks (`chats.key`) are authorization, not shell work. */
export type ChannelContract =
  | { owner: "core"; args: readonly Guard[] }
  | { owner: "host-bound"; needs: Capability; args: readonly Guard[] }
  | { owner: "shell" };

const { str, num, bool, none, bytes, obj, arr, opt, nullable, oneOf, either, shape } = g;
const core = (...args: Guard[]): ChannelContract => ({ owner: "core", args });
const bound = (needs: Capability, ...args: Guard[]): ChannelContract => ({ owner: "host-bound", needs, args });
const shell: ChannelContract = { owner: "shell" };
const bot = oneOf("discord", "teams");
const list = arr(() => true);

// Request payloads: required fields and their types (handlers still check ids, paths, sizes, enums).
const turn = shape({ role: oneOf("user", "assistant", "system"), content: str, id: opt(str) });
const image = shape({ data: str, mimeType: str });
const chatRequest = shape({
  history: arr(turn), message: str, source: opt(str), incognito: opt(bool), droppedUrl: opt(str),
  linkedNote: opt(obj), images: opt(arr(image)), documents: opt(list), turnId: opt(str),
});
const project = shape({ name: str, path: str, defaultSkill: opt(str), skills: opt(arr(str)) });
const persona = shape({ name: str, tags: arr(str) });
const configUpdate = shape({
  openaiApiKey: str, model: str, terminalApp: str, editorApp: str, delegateCli: str, systemControls: bool,
  reasoningEffort: str, routineDigestContext: bool, disabledClis: arr(str), webSearch: bool, autoMemory: bool,
});
const noteDraft = shape({ title: str, body: str, project: opt(str), source: opt(oneOf("chat", "manual")), slug: opt(str) });
const memory = shape({
  id: str, text: str, createdAt: str, projectPath: opt(str), subjectId: opt(str), category: opt(str),
  sourceId: opt(str), sourceTitle: opt(str),
});
const delegateStart = shape({ projectPath: str, prompt: str, instruction: str, model: opt(str), cli: opt(str), skillName: opt(str) });
const liveStart = shape({
  agent: str, projectPath: str, ask: str, label: opt(str), model: opt(str),
  history: opt(arr(shape({ role: oneOf("user", "reply"), text: str, agent: opt(str) }))),
});
const launch = shape({ mode: str, projectPath: str, prompt: opt(str), model: opt(str) });
const threadSave = shape({ id: str, title: str, items: list, noteSlug: opt(str) });
const closeOpts = shape({ incognito: bool, rejected: arr(str), mountId: str });
const deskContinue = shape({ channelId: str, title: str, sessionId: opt(str) });
const watch = either(
  shape({ kind: oneOf("feed"), url: str, everyMinutes: opt(num), window: opt(obj) }),
  shape({ kind: oneOf("command"), command: str, everyMinutes: opt(num), window: opt(obj) }),
);
const routine = shape({
  name: str, description: opt(str), enabled: bool, cron: opt(str), watch: opt(watch), todoDriven: opt(bool),
  maxParallel: opt(num), webSearch: opt(bool), steps: arr(obj), sinks: obj,
});
const brief = shape({
  name: str, description: opt(str), trigger: oneOf("schedule", "watch"), cron: opt(str), source: opt(str),
  everyMinutes: opt(num), notifyOnly: opt(bool), steps: arr(obj), sinks: obj, missing: arr(obj), builder: opt(obj),
});

// Push payloads: the fields a subscriber reads.
const delegateEvent = shape({ taskId: str, type: oneOf("started", "output", "done", "failed", "cancelled"), mountId: opt(str) });
const liveEvent = shape({ sessionId: str, agent: str, mountId: str, seq: num, type: str });
const terminalEvent = shape({ mountId: str, tabId: str, type: oneOf("data", "busy", "exit") });
const memoryUpdated = shape({ saved: arr(shape({ id: str, text: str, category: opt(nullable(str)) })), mountId: str });
const taskJob = shape({ id: str, kind: str, name: str, state: oneOf("running", "done", "failed") });
const chatopsEvent = shape({ bot, running: bool, enabled: bool });
const syncedChatEvent = shape({ surface: str, conversationId: opt(str), saved: opt(bool) });

export const CHANNEL_CONTRACT = {
  handshake: core(),
  launch: bound("terminalHandoff", launch),
  delegateStart: core(delegateStart, str),
  delegateCancel: core(str),
  delegateEvent: core(delegateEvent),
  liveStart: core(liveStart, str),
  liveSend: core(str, str, str),
  liveStop: core(str, str),
  liveInterrupt: core(str, str, num),
  liveResume: core(str, str),
  liveEvent: core(liveEvent),
  terminalStart: bound("pty", str, num, num, str, str),
  terminalWrite: bound("pty", str, str, str),
  terminalResize: bound("pty", num, num, str, str),
  terminalAck: bound("pty", num, str, str),
  terminalStop: bound("pty", str, opt(str)),
  terminalRunning: bound("pty", str, opt(str)),
  terminalOpenLink: bound("pty", str, str),
  chatOpenPath: bound("pathOpen", str, str),
  terminalEvent: bound("pty", terminalEvent),
  availableClis: core(),
  detectedClis: core(),
  availableModels: core(),
  cliAvailabilityChanged: core(none),
  getModelMemory: core(str),
  setModelMemory: core(str, str),
  chat: core(chatRequest, str),
  chatStop: core(str, str),
  chatImageProgress: core(str),
  chatStageImage: core(str, str, str),
  listSkills: core(),
  listProjects: core(),
  saveProjects: core(arr(project)),
  pickProjectFolder: bound("pathOpen"),
  pickTerminalApp: bound("pathOpen"),
  pickEditorApp: bound("pathOpen"),
  revealInFinder: bound("pathOpen", str),
  saveSkill: core(str, str),
  deleteSkill: core(str),
  getPersona: core(),
  savePersona: core(persona),
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
  taskStatus: core(arr(taskJob)),
  dismissTask: core(str),
  openChatMount: shell,
  showChatMount: shell,
  planDrop: core(str, str),
  getConfig: core(),
  saveConfig: core(configUpdate),
  getAppInfo: shell,
  quit: shell,
  runInChat: shell,
  chatPrompt: shell,
  getPendingChatPrompt: shell,
  interruptedRunNotice: shell,
  getPendingInterruptedRunNotices: shell,
  listNotes: core(opt(shape({ includeArchived: opt(bool) }))),
  saveNote: core(noteDraft, opt(arr(image))),
  archiveNote: core(str),
  restoreNote: core(str),
  purgeNote: core(str),
  starNote: core(str, bool),
  noteHistory: core(str),
  saveNoteImage: core(bytes),
  noteImage: core(str),
  listMemories: core(),
  appendMemories: core(arr(memory)),
  updateMemory: core(str, str),
  deleteMemories: core(arr(str)),
  updateMemoryCategory: core(str, nullable(str)),
  renameMemoryCategory: core(str, str),
  memoryOwnerIds: core(),
  rememberOnClose: core(arr(turn), closeOpts),
  memoryUpdated: core(memoryUpdated),
  chatAttach: core(str),
  chatRelease: core(str),
  chatIncognito: core(bool, str),
  chatThreadSave: core(threadSave, str),
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
  syncedChatEvent: core(syncedChatEvent),
  deskContinue: core(deskContinue, str),
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
  chatopsEvent: core(chatopsEvent),
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
  routinesSave: core(routine),
  routinesDelete: core(str),
  routinesRunNow: core(str),
  routineStop: core(str),
  routinesState: core(),
  routinesAttempts: core(str),
  routinesCheckNow: core(str),
  routinesPreviewWatch: core(watch),
  routinesEnableWatch: core(str, bool),
  routinesSinkRecipients: core(),
  routinesDraftBrief: core(str, opt(brief)),
  routinesBuild: core(brief),
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
  coreList: shell,
  coreAdd: shell,
  coreRemove: shell,
  coreSwitch: shell,
  coreStatus: shell,
  coreStatusChanged: shell,
  coreTakeBack: shell,
  chatCloseKept: shell,
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

/** No core attached (#810): every core and host-bound invoke rejects with the one `NO_CORE` error; their
 * sends have no listener, so they are dropped. The shell's own channels are registered as usual. */
export function registerNoCore(ipc: Pick<IpcLike, "handle">): void {
  for (const [key, c] of Object.entries(CHANNEL_CONTRACT)) {
    if (c.owner !== "shell") ipc.handle(IPC[key as keyof typeof IPC], () => { throw new Error(NO_CORE); });
  }
}
