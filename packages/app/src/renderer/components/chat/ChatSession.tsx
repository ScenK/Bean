import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChatPanel, type StopTarget } from "./ChatPanel.js";
import { PDF_NO_PATH, insertDroppedPath, newId, type AgentId, type ChatItem, type PinnedPdf } from "../../shared/chat-types.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import {
  HANDOFF_ITEMS, chatTurns, handoffItems, handoffLines, ensureStreaming, applyLiveEvent, consumeLive, isLiveAgent, offerAgent,
  LIVE_AGENTS, liveModelKey, liveProjectKey, offerLaunch, validModel, validProject, type AgentPick, type AgentPicks,
  LABEL_LIMIT, imageLabel, nextImageNumber, withImagePaths,
} from "./agent-mode.js";
import { resolveSlash, terminalDestination } from "./slash-commands.js";
import type { TabShortcut } from "./TerminalPane.js";
import { continuedTo, normalizeForSave, pdfAskAgain, restoredPdf, restoreItems, threadTitle } from "./chat-thread.js";
import { ContinueDiscord } from "./ContinueDiscord.js";
import { withSaveAck } from "./ChatSidebar.js";
import { composePrompt } from "@bean/core/prompt";
import { sproutCheckText } from "@bean/core/sprout-trigger";
import { dataUrlToAttachment } from "../../shared/note-images.js";
import type {
  AvailableModel, CliName, DesktopChatListing, ImageAttachment, LiveCli, LinkedNote, Project, ProposedDelegate, ProposedNote, ProposedSkill, RouteSuggestion, Skill, TurnSource,
} from "@bean/core";
import type { ChatDrop } from "../../../channels.js";
import type { DelegateEvent } from "../../../delegate-tasks.js";
import type { LiveEvent, LiveReceipt, LiveStartResult } from "../../../live-tasks.js";
import type { CloseTurn, InterruptedRunNotice } from "../../../ipc.js";

// Leaving an off-the-record chat discards it, so a running delegate, live session or terminal command
// asks Keep/Stop first (`switchTo` = the pick). Any other chat with work stays mounted, hidden. `null` = no card.
// Window close asks in the shell (ChatWindow), across every chat.
type LeaveFlow = { switchTo: string; title: string } | null;

// Transcript handed to rememberOnClose — see chatTurns (live steering and agent finals stay out).
// Nothing typed since this window loaded = nothing new to remember (a restored chat's turns were
// covered when it first closed), so no extraction call at all.
export const closeTranscript = (items: ChatItem[], typedSinceLoad: boolean): CloseTurn[] =>
  typedSinceLoad ? chatTurns(items, { memory: true }) : [];

/** Desktop chat history: a change is written at most this long after it lands. */
export const THREAD_SAVE_MS = 1000;

/** The window's agent session. `key` tells a start apart from a later one; `sessionId` arrives with
 * the `started` event (or liveStart's result); texts typed before it are `queued`. `continuing` =
 * resumed from a receipt (Continue live). `receipt` = the CLI's own session, from the `session` event.
 * `unopened` = texts sent to a continued session before its resume was accepted (it opens lazily, on
 * the first send) — handed back to the composer if the host rejects the id. `model` = the `--model` it
 * launched with (unset = the agent's default, or a resumed session). `stopping` = a Stop is in flight,
 * until the next `turn`/`ended` or main refuses it. Its user rows carry `pending: key` until the agent
 * picks them up (`consumed`), the send is refused, or the session ends (#746). */
interface LiveState {
  key: string; agent: LiveCli; projectPath: string; model?: string; sessionId?: string; turns: number; busy: boolean;
  queued: { text: string; rowId: string }[];
  continuing?: boolean; receipt?: LiveReceipt; unopened?: string[]; stopping?: boolean;
}

type QueuedSend = { text: string; display?: string; source?: TurnSource };

/** A chat continued in Discord starts no work here any more: every card still awaiting a tap expires. */
export const expirePending = (items: readonly ChatItem[]): ChatItem[] =>
  items.map((it) => ("state" in it && it.state === "pending" ? { ...it, state: "expired" } as ChatItem : it));

/** The rows a successful Continue in Discord appends: a `partial` note, then the pointer. */
export const continuedRows = (threadId: string, title: string, partial: boolean): ChatItem[] => [
  ...(partial ? [{ kind: "status" as const, id: newId(), text: "The thread opened, but not everything carried over — see the thread.", tone: "error" as const }] : []),
  { kind: "continued", id: newId(), surface: "discord", conversationId: threadId, title },
];

/** A desk-continue refusal code, in words. */
export function continueRefusal(code: string): string {
  switch (code) {
    case "no-owner": return "The Discord bot has no owner set in discord.json.";
    case "thread-failed": return "Couldn't open a thread there — Bean needs Create Public Threads and Send Messages in Threads in that channel.";
    case "unsupported": return "The Discord bot can't take an agent session (live sessions are off).";
    case "cli-missing": return "That agent's CLI isn't installed where the bot runs.";
    case "no-record": return "The bot has no record of this agent session.";
    default: return `The Discord bot refused (${code}).`;
  }
}

export function markDelegateStarting(items: ChatItem[], id: string): ChatItem[] {
  return items.map((it) => (it.kind === "delegate" && it.id === id ? { ...it, state: "starting" as const } : it));
}

export function hasActiveDelegates(items: ChatItem[], pendingStarts: number): boolean {
  return pendingStarts > 0 || items.some((it) => it.kind === "delegate" && (it.state === "starting" || it.state === "running"));
}

export function addDelegateProposal(items: ChatItem[], proposal: ProposedDelegate, id: string): ChatItem[] {
  return [...items, { kind: "delegate", id, proposal, state: "pending", tail: [] }];
}

export function applyDelegateEventToItems(
  items: ChatItem[],
  e: DelegateEvent,
): { items: ChatItem[]; loopback?: QueuedSend } {
  const match = items.find(
    (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.taskId === e.taskId,
  );
  if (!match) return { items };
  return {
    items: items.map((it) => {
      if (it.kind !== "delegate" || it.taskId !== e.taskId) return it;
      if (e.type === "output") return { ...it, tail: [...it.tail.slice(-29), e.line] };
      const receipt = e.type !== "started" && e.receipt ? { receipt: e.receipt } : {};
      if (e.type === "done") return { ...it, state: "done" as const, result: e.result, ...receipt };
      if (e.type === "failed") return { ...it, state: "failed" as const, error: e.message, ...receipt };
      if (e.type === "cancelled") return { ...it, state: "cancelled" as const, ...receipt };
      return it;
    }),
    loopback: e.type === "done" ? {
      text: `[delegate result for "${match.proposal.instruction}"]: ${e.result}\n\nBriefly summarize this outcome for the user in your own words.`,
      display: "📦 Delegate finished",
      source: "loopback",
    } : undefined,
  };
}

export function attachDelegateTaskId(
  items: ChatItem[],
  id: string,
  taskId: string,
  instruction: string,
  buffered: DelegateEvent[],
): { items: ChatItem[]; loopbacks: QueuedSend[] } {
  let next = items.map((it) => (
    it.kind === "delegate" && it.id === id ? { ...it, state: "running" as const, taskId, proposal: { ...it.proposal, instruction } } : it
  ));
  const loopbacks: QueuedSend[] = [];
  for (const event of buffered) {
    const result = applyDelegateEventToItems(next, event);
    next = result.items;
    if (result.loopback) loopbacks.push(result.loopback);
  }
  return { items: next, loopbacks };
}

/** Running tasks in one chat, for the window-close card. `terminal` is the command running in each
 * busy tab's foreground (main's fresh check), set only while one runs — idle shells close silently. */
export interface ChatTasks { delegates: number; live?: LiveCli; terminal?: string[] }

/** Running commands for a card: "npm", "npm and vim", "npm, vim + 1 more". */
export function commandList(cmds: string[]): string {
  if (cmds.length <= 2) return cmds.join(" and ");
  return `${cmds.slice(0, 2).join(", ")} + ${cmds.length - 2} more`;
}

/** The leave card for a chat that's discarded on leaving (off the record, or empty), if it has work. */
export function leaveTitle(t: ChatTasks): string | undefined {
  const task = t.delegates > 0 || t.live !== undefined;
  const cmds = t.terminal ?? [];
  if (cmds.length > 0) {
    return `Leaving discards this chat and stops ${task ? "its task and " : ""}${commandList(cmds)} in its terminal${cmds.length > 1 ? "s" : ""}.`;
  }
  return task ? "Leaving discards this chat and stops its task." : undefined;
}

/** What the window shell (ChatWindow) routes to a mounted chat: the preload's `on*` bridges can't
 * unsubscribe, so the shell registers them once and calls the chat an event is tagged with (or the
 * shown one). */
export interface ChatSessionApi {
  mountId: string;
  delegateEvent: (e: DelegateEvent) => void;
  liveEvent: (e: LiveEvent) => void;
  /** The thread this chat writes, once it has one. */
  threadId: () => string | undefined;
  /** Its thread was renamed in the sidebar: the stored title, for Continue in Discord. */
  renamed: (title: string) => void;
  /** A per-turn "Memory updated" receipt for this chat (the shell routes by mount and thread). */
  memoryUpdated: (saved: Array<{ id: string; text: string; category?: string }>) => void;
  imageProgress: () => void;
  runPrompt: (p: { prompt: string; label: string; noteSlug?: string }) => void;
  notices: (notices: InterruptedRunNotice[]) => void;
  /** A sidebar pick ("new" or a thread id) while this chat is shown. */
  open: (target: string) => void;
  /** An error row in this chat (a failed sidebar delete). */
  error: (text: string) => void;
  /** Its running delegates, live session and terminal command (the window-close count). */
  tasks: () => Promise<ChatTasks>;
  /** Stop them (window close's Stop & close). */
  stopTasks: () => Promise<void>;
  /** Window close: the final save and close-time memory. */
  closeOut: () => Promise<void>;
  /** A switch elsewhere: a hidden chat with nothing running evicts itself (onEvicted). */
  sweep: () => void;
  /** Control+` while this chat is shown: fold/unfold its terminal pane. */
  toggleTerminal: () => void;
  /** A terminal tab shortcut while this chat is shown. */
  terminalShortcut: (s: TabShortcut) => void;
}

export interface ChatSessionProps {
  /** This chat's key in main (ipc.ts buildChatMounts) — a fresh UUID per mount. */
  mountId: string;
  /** A saved thread to restore on mount; undefined = a new chat. */
  restoreId?: string;
  /** The shell's registry: this chat puts its api here on each render, removed at unmount. */
  sessions: Map<string, ChatSessionApi>;
  /** Mounted but not shown — it has work in flight (#517). */
  hidden: boolean;
  clis: CliName[];
  runModels: AvailableModel[];
  prefillUrl?: ChatDrop;
  setThreads: (update: (prev: DesktopChatListing[]) => DesktopChatListing[]) => void;
  onActive: (id: string | undefined) => void;
  /** Its switch-away save is in flight (the sidebar waits). */
  onBusy: (busy: boolean) => void;
  /** Its thread while it has work in flight (the sidebar spinner), undefined once idle. */
  onWorking: (threadId: string | undefined) => void;
  /** Its thread while an agent (live) session is open — the sidebar's green bar; undefined = none. */
  onLive: (threadId: string | undefined) => void;
  /** Its terminal has a live shell (the sidebar's `>_`), or no longer does. */
  onTerminal: (alive: boolean) => void;
  /** A reply or live turn landed while hidden (the sidebar dot). */
  onUnread: () => void;
  /** This shown chat is leaving for the pick: `keep` = it stays mounted, hidden (work in flight);
   * otherwise it's evicted (saved, memory handed off) and the shell unmounts it. */
  onSwitch: (target: string, keep: boolean) => void;
  /** A hidden chat evicted itself (sweep): the shell unmounts it. */
  onEvicted: () => void;
  /** Receipts that landed after this thread's chat was switched away — shown again on restore. */
  takeLateReceipts: (threadId: string) => Array<Array<{ id: string; text: string; category?: string }>>;
  /** The app-spawned Discord bot is running (Continue in Discord needs it). */
  discordBot: boolean;
  /** Show a Discord thread's synced view (after Continue in Discord, or Open thread). */
  onOpenSynced: (conversationId: string) => void;
}

/** One chat inside the chat window. A switch evicts it — final save, close-time memory, release —
 * and the shell mounts the next one with a new mount id; the window itself stays. */
export function ChatSession({
  mountId, restoreId, sessions, hidden, clis, runModels, prefillUrl, setThreads, onActive, onBusy, onWorking, onLive, onTerminal, onUnread, onSwitch, onEvicted, takeLateReceipts, discordBot, onOpenSynced,
}: ChatSessionProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("model");
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [leaveFlow, setLeaveFlow] = useState<LeaveFlow>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  // Attached in a layout effect, so before any passive effect's request; released at unmount.
  useLayoutEffect(() => {
    window.bean.chatAttach(mountId);
    return () => window.bean.chatRelease(mountId);
  }, []);
  // Off the record: per window (a new chat starts off). Read at close, and mirrored to main so it
  // also stops per-turn captures still in flight. Facts captured before it was switched on stay
  // saved — their "Memory updated" rows keep Undo.
  const [incognito, setIncognito] = useState(false);
  const incognitoRef = useRef(false);
  incognitoRef.current = incognito;
  const removedNoticeRef = useRef<string | undefined>(undefined);
  // Sent from the toggle itself, not an effect: a close right after the click must not beat it.
  const toggleIncognito = (): void => {
    const on = !incognitoRef.current;
    incognitoRef.current = on;
    window.bean.setChatIncognito(on, mountId);
    setIncognito(on);
    // Main deletes the saved thread and latches the window unsavable; mirrored here so no save is
    // even attempted. Sticky — toggling back off doesn't resume history, but its notice goes with
    // the switch (the chat staying out of the sidebar is the lasting cue).
    if (!on && removedNoticeRef.current) {
      const id = removedNoticeRef.current;
      removedNoticeRef.current = undefined;
      setItems((prev) => prev.filter((it) => it.id !== id));
    }
    if (on && !unsavableRef.current) {
      unsavableRef.current = true;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      removedNoticeRef.current = newId();
      addStatus("Removed from history. Nothing in this chat will be saved.", "info", undefined, removedNoticeRef.current);
      const gone = threadRef.current?.id;
      setThreads((prev) => prev.filter((t) => t.id !== gone));
    }
  };
  // Desktop chat history (chat-thread.ts). `threadRef` is assigned on the first composer input (or
  // by a restore); `savedRef` is the last written snapshot — a restore's is the baseline, so only a
  // real change writes and viewing a chat never bumps it. `flushRef` = write on the next render.
  const threadRef = useRef<{ id: string; title: string } | undefined>(undefined);
  const unsavableRef = useRef(false);
  const savedRef = useRef<string | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushRef = useRef(false);
  // Each write resolves to whether it landed (it never rejects) — a switch waits on that.
  const savingRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const typedSinceLoadRef = useRef(false);
  // Set while a switch saves this chat on its way out; the sidebar stays disabled meanwhile.
  const evictingRef = useRef(false);
  const [evicting, setEvicting] = useState(false);
  useEffect(() => onBusy(evicting), [evicting]);
  // Facts undone from a "Memory updated" row or forgotten by forget_memory — handed to close
  // catch-up so it won't re-save them.
  const rejectedMemoriesRef = useRef<string[]>([]);
  const [linkedNote, setLinkedNote] = useState<LinkedNote | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);
  const [lastUsedModels, setLastUsedModels] = useState<Record<string, string>>({});
  const [autoFocusDelegateId, setAutoFocusDelegateId] = useState<string | undefined>(undefined);
  // Full current skill list — passed to SkillCard so its "replaces existing" chip tracks
  // the user's live-edited name against real skills, not a stale server-computed flag.
  const [skills, setSkills] = useState<Skill[]>([]);
  const [delegateCli, setDelegateCli] = useState("");
  // The `/` menu's catalogs — refreshed each time the menu opens. A terminal skill's caption names
  // its delegate destination, so its remembered model and the Settings CLI preference come too.
  const refreshCatalogs = (): void => {
    window.bean.listSkills().then((s) => {
      setSkills(s ?? []);
      // ponytail: one IPC per terminal skill; add a bulk model-memory getter if skill lists grow large.
      for (const k of s ?? []) {
        if (k.target === "chat") continue;
        void window.bean.getModelMemory(k.name).then((m) => { if (m) setLastUsedModels((prev) => ({ ...prev, [k.name]: m })); }, () => {});
      }
    }, () => {});
    window.bean.getConfig().then((c) => setDelegateCli(c?.delegateCli ?? ""), () => {});
  };
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  // Agent mode: who answers typed composer text. A pick only switches; the agent spawns on the
  // first typed send. Refs mirror state for async callbacks (live events, awaited starts).
  const [mode, setModeState] = useState<AgentId>("bean");
  const modeRef = useRef<AgentId>("bean");
  const setMode = (m: AgentId): void => { modeRef.current = m; setModeState(m); };
  // The last project used in this window ("" = Bean's scratch workspace) — never projects[0].
  const [agentProject, setAgentProjectState] = useState("");
  const agentProjectRef = useRef("");
  const rememberProject = (path: string): void => { agentProjectRef.current = path; setAgentProjectState(path); };
  // This chat's terminal pane (TerminalPane): folded by default, never persisted.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const toggleTerminal = (): void => setTerminalOpen((o) => !o);
  // How many of its tabs hold a running shell (idle or busy) — any keeps a hidden chat mounted.
  const shellRef = useRef(0);
  const onShells = (count: number): void => { shellRef.current = count; onTerminal(count > 0); };
  // The pane's tab-shortcut handler (Cmd+T / Cmd+1…4 / Cmd+Shift+[ ]), set by TerminalPane.
  const terminalShortcutRef = useRef<((s: TabShortcut) => void) | null>(null);
  // A discarding leave is awaiting main's terminal check: a second pick meanwhile is ignored.
  const leavingRef = useRef(false);
  // The agent's model for the next fresh start ("" = its own default).
  const [agentModel, setAgentModelState] = useState("");
  const agentModelRef = useRef("");
  const setAgentModel = (m: string): void => { agentModelRef.current = m; setAgentModelState(m); };
  // Each agent's last project + model (#612): seeded at mount from model memory, updated by chip picks,
  // restored on a switch to that agent. Read synchronously — `/claude <ask>` restores and starts in one tick.
  const [picks, setPicksState] = useState<AgentPicks>({});
  const picksRef = useRef<AgentPicks>({});
  const updatePick = (agent: LiveCli, patch: AgentPick): void => {
    picksRef.current = { ...picksRef.current, [agent]: { ...picksRef.current[agent], ...patch } };
    setPicksState(picksRef.current);
  };
  const [live, setLiveState] = useState<LiveState | undefined>(undefined);
  // Agent-mode images (#628): `[Image #N]` → the file it stands for. Chat-scoped and never cleared on
  // send, so a handed-back `typed` text still resolves; only the agent's text ever gets the paths.
  const imageLabelsRef = useRef(new Map<number, { path: string; agent: LiveCli }>());
  const labelImage = (path: string, composer: string, agent: LiveCli): string => {
    const n = nextImageNumber(itemsRef.current, composer, imageLabelsRef.current);
    imageLabelsRef.current.set(n, { path, agent });
    return imageLabel(n);
  };
  const stageImage = (img: ImageAttachment): Promise<string> => window.bean.chatStageImage(img.data, img.mimeType, mountId);
  // Text handed back to the composer (a rejected Continue live); a fresh object per hand-back.
  const [refill, setRefill] = useState<{ text: string } | undefined>(undefined);
  const liveRef = useRef<LiveState | undefined>(undefined);
  const setLive = (l: LiveState | undefined): void => { liveRef.current = l; setLiveState(l); };
  // Sessions this window adopted — events from any other (a start abandoned mid-startup) are ignored.
  const knownSessionsRef = useRef(new Set<string>());
  // Hand-off offers already started (startOffer's claim-once guard).
  const offersClaimedRef = useRef(new Set<string>());
  const busyRef = useRef(false);
  // Bean's own running turn (its turnId) and whether a Stop is in flight for it.
  const beanTurnRef = useRef<{ id: string; stopping?: boolean } | undefined>(undefined);
  const [beanTurn, setBeanTurnState] = useState<{ id: string; stopping?: boolean } | undefined>(undefined);
  const setBeanTurn = (t: { id: string; stopping?: boolean } | undefined): void => { beanTurnRef.current = t; setBeanTurnState(t); };
  const queuedSendsRef = useRef<QueuedSend[]>([]);
  const pendingDelegateStartsRef = useRef(new Map<string, Promise<string>>());
  const delegateTaskIdsRef = useRef(new Map<string, string>());
  const pendingDelegateEventsRef = useRef(new Map<string, DelegateEvent[]>());
  // sendMessage is reached via sendRef from async callbacks, so it reads the linked note through a
  // ref too — state alone would be a stale closure there.
  const linkedNoteRef = useRef<LinkedNote | undefined>(undefined);
  linkedNoteRef.current = linkedNote;
  // The chat's pinned PDF (#731): its bytes ride on every Bean turn (core re-sends documents each
  // turn) and never on a ChatItem, so no save carries them. `sent` = a turn already attached it.
  const [pdf, setPdfState] = useState<(PinnedPdf & { sent: boolean }) | undefined>(undefined);
  const pdfRef = useRef<(PinnedPdf & { sent: boolean }) | undefined>(undefined);
  const setPdf = (p: (PinnedPdf & { sent: boolean }) | undefined): void => { pdfRef.current = p; setPdfState(p); };
  const attachPdf = (next: PinnedPdf): void => {
    const old = pdfRef.current;
    if (old) addStatus(`📄 ${next.filename} replaces ${old.filename} — Bean reads only one PDF per chat.`, "info");
    setPdf({ ...next, sent: false });
  };
  const removePdf = (): void => {
    const old = pdfRef.current;
    setPdf(undefined);
    if (old?.sent) addStatus(`📄 ${old.filename} removed — Bean no longer sees it.`, "info");
  };
  // A pending (never sent) PDF carried into an agent leaves Bean: the agent gets its path as text —
  // or, with no path, the Finder notice. A sent one stays pinned for Bean; the handoff marks it.
  const takePendingPdf = (): string | undefined => {
    const doc = pdfRef.current;
    if (!doc || doc.sent) return undefined;
    setPdf(undefined);
    if (!doc.path) addStatus(PDF_NO_PATH, "info");
    return doc.path || undefined;
  };
  // Async callbacks (a chat prompt after its note lookup, delegate loopbacks) reach sendMessage
  // through a ref — a direct reference would close over a stale render's `busy`/`items`.
  const sendRef = useRef<(text: string, display?: string, queueIfBusy?: boolean, images?: ImageAttachment[], source?: TurnSource) => Promise<void>>(async () => {});

  const snapshot = (): string => JSON.stringify([normalizeForSave(itemsRef.current), linkedNoteRef.current?.slug ?? null]);
  // Writes run one at a time, in order; a failed one is retried by the next change. Resolves to
  // whether the current snapshot is saved (true when there's nothing to save).
  const saveThread = (): Promise<boolean> => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    const t = threadRef.current;
    if (!t || unsavableRef.current) return Promise.resolve(true);
    const snap = snapshot();
    if (snap === savedRef.current) return savingRef.current;
    savedRef.current = snap;
    const [items, noteSlug] = JSON.parse(snap) as [ChatItem[], string | null];
    savingRef.current = savingRef.current
      .then(() => window.bean.chatThreadSave({ id: t.id, title: t.title, items, ...(noteSlug ? { noteSlug } : {}) }, mountId))
      .then((ack) => {
        if (ack) setThreads((prev) => withSaveAck(prev, ack, items));
        return true;
      }, (err: unknown) => {
        if (savedRef.current === snap) savedRef.current = undefined;
        console.error("chat history save failed:", err);
        return false;
      });
    return savingRef.current;
  };
  useEffect(() => {
    if (!threadRef.current || unsavableRef.current) return;
    if (flushRef.current) { flushRef.current = false; void saveThread(); return; }
    saveTimerRef.current ??= setTimeout(() => void saveThread(), THREAD_SAVE_MS);
  }, [items, linkedNote]);

  useEffect(() => {
    window.bean.getModel().then(setModel);
    window.bean.listProjects().then(setProjects);
    refreshCatalogs();
    // An absent key stays absent (project: keep the window's; model: default). A pick made before
    // the read lands wins over it.
    for (const cli of LIVE_AGENTS) {
      void Promise.all([window.bean.getModelMemory(liveModelKey(cli)), window.bean.getModelMemory(liveProjectKey(cli))]).then(([model, project]) => {
        const seeded: AgentPick = { ...(typeof model === "string" ? { model } : {}), ...(typeof project === "string" ? { project } : {}) };
        updatePick(cli, { ...seeded, ...picksRef.current[cli] });
      }, () => {});
    }
    if (!restoreId) return;
    // A thread picked from history: restored inert (chat-thread.ts), its snapshot the baseline. The
    // linked-note chip comes back only if that note still exists.
    window.bean.chatThreadGet(restoreId, mountId).then(async (t) => {
      if ("missing" in t) {
        addStatus("That chat is no longer in history — it was deleted, or not opened for 90 days.", "info");
        return;
      }
      const note = t.noteSlug ? (await window.bean.listNotes().catch(() => [])).find((n) => n.slug === t.noteSlug) : undefined;
      if (note) {
        const linked = { slug: note.slug, title: note.title, version: note.version, body: note.body };
        linkedNoteRef.current = linked;
        setLinkedNote(linked);
      }
      threadRef.current = { id: t.id, title: t.title };
      onActive(t.id);
      const restored = restoreItems(t.items);
      // PDF bytes are never saved: ask for the file again. Part of the baseline, so viewing still
      // never writes; restoredPdf skips the ask once a later save has kept it.
      const pdfName = restoredPdf(restored);
      itemsRef.current = [...restored, ...(pdfName ? [{ kind: "status", id: newId(), tone: "info", text: pdfAskAgain(pdfName) } satisfies ChatItem] : []), ...itemsRef.current];
      savedRef.current = snapshot();
      // A receipt that missed this chat (it was switched away mid-capture) comes back live, Undo
      // included — and is then saved like any new row.
      const late = takeLateReceipts(t.id).map((saved): ChatItem => ({ kind: "memory", id: newId(), saved, state: "saved" }));
      if (late.length > 0) {
        itemsRef.current = [...itemsRef.current, ...late];
        flushRef.current = true;
      }
      setItems(itemsRef.current);
    }, (err: unknown) => addStatus(`Couldn't open that chat: ${err instanceof Error ? err.message : String(err)}`, "error"));
  }, []);

  // A chat-target skill run confirmed in the Plan popup: auto-send its composed prompt, collapsed to
  // `▶ label` in the transcript.
  const runPrompt = (p: { prompt: string; label: string; noteSlug?: string }): void => {
    void (async () => {
      // "Continue in chat" from a note: link this chat to it before the first send so the
      // note body rides along (as framed user-role data) and saves default to update-in-place.
      if (p.noteSlug) {
        // Default listNotes() hides archived notes, so an archived note is never linked.
        const note = (await window.bean.listNotes()).find((n) => n.slug === p.noteSlug);
        if (note) {
          const linked = { slug: note.slug, title: note.title, version: note.version, body: note.body };
          linkedNoteRef.current = linked;
          setLinkedNote(linked);
        }
      }
      await sendRef.current(p.prompt, `▶ ${p.label}`, false, undefined, "skill");
    })();
  };

  const sendMessage = async (
    text: string, display?: string, queueIfBusy = false, images?: ImageAttachment[], source: TurnSource = "typed",
  ): Promise<void> => {
    const message = text.trim();
    if (!message || continuedTo(itemsRef.current)) return; // read-only: no turn, so no new cards
    if (busyRef.current) {
      if (queueIfBusy) queuedSendsRef.current.push({ text: message, display, source });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setStatus("working");
    const workingId = newId();
    const turnId = newId();
    setBeanTurn({ id: turnId });
    // The pinned PDF goes with every Bean turn; only the turn that attaches it shows its chip.
    const doc = pdfRef.current;
    const attaching = doc !== undefined && !doc.sent;
    if (attaching) setPdf({ ...doc, sent: true });
    setItems((prev) => [...prev, {
      kind: "user", id: turnId, text: message, display, source,
      images: images?.map((i) => `data:${i.mimeType};base64,${i.data}`),
      ...(attaching ? { pdf: { name: doc.filename, size: doc.size } } : {}),
    }, { kind: "working", id: workingId, text: attaching ? `Reading ${doc.filename}…` : "Spinning up" }]);
    // A turn that sent the PDF and failed unpins it, so the next turn isn't sunk by the same file.
    const unpinFailed = (): void => { if (doc && pdfRef.current?.data === doc.data) setPdf(undefined); };

    // Image bytes ride only on the current turn; older turns keep a text placeholder
    // (mirrors chatops — see core's latestUserImages doc comment).
    const history = chatTurns(itemsRef.current);

    try {
      const documents = doc ? [{ data: doc.data, filename: doc.filename }] : undefined;
      const res = await window.bean.chat({ history, message, source, incognito: incognitoRef.current, linkedNote: linkedNoteRef.current, images, documents, turnId }, mountId);
      if (res.model) setModel(res.model);
      // Stopped while attaching: the file may be what hung, so it's unpinned like a failure. A PDF an
      // earlier turn already read stays pinned.
      if (res.stopped && attaching) unpinFailed();
      if (doc && res.error && !res.stopped) {
        unpinFailed();
        res.reply = `${res.reply}\n\nI couldn't read ${doc.filename} — it may have too many pages or be password-protected, ` +
          "or this model doesn't take files. I've unpinned it; drop it again to retry.";
      }
      // Forgotten facts go to close catch-up as already handled, so closing doesn't re-save them.
      rejectedMemoriesRef.current.push(...(res.forgotten ?? []).map((m) => m.text));

      setItems((prev) => {
        const next = prev.filter((it) => it.id !== workingId);
        const generated = res.generatedImages?.filter(
          (g): g is { path: string; dataUrl: string } => typeof g.dataUrl === "string",
        );
        if (res.reply.trim() || generated?.length) {
          next.push({ kind: "reply", id: newId(), text: res.reply, images: generated?.length ? generated : undefined });
        }
        if (res.proposedRun) {
          next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
          const skillName = res.proposedRun.skillName;
          void window.bean.getModelMemory(skillName).then((modelId) => {
            if (modelId) setLastUsedModels((prev) => ({ ...prev, [skillName]: modelId }));
          });
        }
        if (res.proposedNote) {
          // Offer the images from the chat's latest turn that had any (chatops does the same).
          const withImages = [...next].reverse().find(
            (it): it is Extract<ChatItem, { kind: "user" }> => it.kind === "user" && (it.images?.length ?? 0) > 0,
          );
          next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending", images: withImages?.images });
        }
        if (res.proposedSkill) next.push({ kind: "skill", id: newId(), skill: res.proposedSkill, state: "pending" });
        if (res.proposedTodo) next.push({ kind: "todo", id: newId(), todo: res.proposedTodo, state: "pending" });
        if (res.sproutRun) next.push({ kind: "sprout", id: newId(), plan: res.sproutRun, state: "pending" });
        if (res.sendCard) next.push({ kind: "send", id: newId(), card: res.sendCard, state: "pending" });
        if (res.proposedDelegate) {
          next.push(...addDelegateProposal([], res.proposedDelegate, newId()));
          const skillName = res.proposedDelegate.skillName;
          if (skillName) {
            void window.bean.getModelMemory(skillName).then((modelId) => {
              if (modelId) setLastUsedModels((prev) => ({ ...prev, [skillName]: modelId }));
            }, () => {});
          }
        }
        if (res.proposedLiveSession) next.push({ kind: "offer", id: newId(), offer: res.proposedLiveSession, state: "pending" });
        for (const m of res.remembered ?? []) next.push({ kind: "status", id: newId(), text: `🧠 Remembered — ${m.text}${m.category ? ` (${m.category})` : ""}`, tone: "done" });
        for (const m of res.forgotten ?? []) next.push({ kind: "forgot", id: newId(), text: m.text, row: m, state: "saved" });
        if (res.stopped) {
          next.push({
            kind: "status", id: newId(), tone: "info",
            text: attaching ? `Stopped by you. 📄 ${doc.filename} unpinned — drop it again to retry.` : "Stopped by you.",
          });
        }
        return next;
      });
      flushRef.current = true;
      setStatus("idle");
      if (hiddenRef.current) onUnread();
    } catch (err) {
      // Main refuses a document that isn't a real PDF (or is oversize): say so and unpin it.
      const why = doc ? ` ${doc.filename} was unpinned: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)}` : "";
      unpinFailed();
      setItems((prev) => [...prev.filter((it) => it.id !== workingId), { kind: "status", id: newId(), text: `Failed to reach Bean.${why}`, tone: "error" }]);
      setStatus("error");
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (beanTurnRef.current?.id === turnId) setBeanTurn(undefined);
      const next = queuedSendsRef.current.shift();
      if (next) void sendMessage(next.text, next.display, true, undefined, next.source);
    }
  };
  sendRef.current = sendMessage;

  const addStatus = (text: string, tone: "info" | "done" | "error", details?: string[], id = newId()): void => {
    setItems((prev) => [...prev, { kind: "status", id, text, tone, ...(details?.length ? { details } : {}) }]);
  };
  // End the window's session (End, a switch, a project change, a close) and say where the chat goes
  // next. A session still starting is stopped once its id arrives (startSession). The row offers
  // Continue live, disabled until the child's `ended` event clears `exiting`.
  const endSession = (next?: string): void => {
    const l = liveRef.current;
    if (!l) return;
    setLive(undefined);
    clearPending((it) => it.pending === l.key);
    if (l.sessionId) window.bean.liveStop(l.sessionId, mountId);
    const row: ChatItem = {
      kind: "status", id: newId(), tone: "info",
      text: `${AGENT_NAMES[l.agent]} ended (${l.turns} turn${l.turns === 1 ? "" : "s"})${next ? ` → ${next}` : ""}`,
      ...(l.receipt ? { receipt: l.receipt, ...(l.sessionId ? { exiting: l.sessionId } : {}) } : {}),
    };
    itemsRef.current = [...itemsRef.current, row]; // a close reads the transcript before the next render
    setItems((prev) => [...prev, row]);
  };

  const switchMode = (next: AgentId): void => {
    if (next === modeRef.current) return;
    endSession(AGENT_NAMES[next]);
    setMode(next);
    if (!isLiveAgent(next)) return;
    const pdfPath = takePendingPdf();
    if (pdfPath) setRefill({ text: pdfPath });
    // The agent's remembered picks, checked against what's configured now.
    const pick = picksRef.current[next];
    const project = validProject(projects, pick?.project);
    if (project !== undefined) rememberProject(project);
    setAgentModel(validModel(runModels, next, pick?.model) ?? "");
  };

  const pickProject = (path: string): void => {
    const agent = modeRef.current;
    if (isLiveAgent(agent)) updatePick(agent, { project: path });
    if (path === agentProjectRef.current) return;
    rememberProject(path);
    // A session is bound to its project: changing it means end + a fresh start on the next send.
    const l = liveRef.current;
    if (l) endSession(`${AGENT_NAMES[l.agent]} · ${projects.find((p) => p.path === path)?.name ?? "scratch"}`);
  };

  // A session runs on the model it started with: the chip's model rows are disabled meanwhile.
  const pickModel = (model: string): void => {
    const agent = modeRef.current;
    if (!isLiveAgent(agent) || liveRef.current) return;
    setAgentModel(model);
    updatePick(agent, { model });
  };

  // After a fresh start the user chose: the next chat (and chatops' next live card, for the model)
  // opens on these. Model then project, in order; a failed write never fails the session.
  const persistPicks = async (agent: LiveCli, projectPath: string, model: string | undefined): Promise<void> => {
    try {
      await window.bean.setModelMemory(liveModelKey(agent), model ?? "");
      await window.bean.setModelMemory(liveProjectKey(agent), projectPath);
    } catch (err) {
      console.error("couldn't remember the agent's picks:", err);
    }
  };

  // "Not read yet" ends for the matching rows: picked up, refused, or their session is gone.
  const clearPending = (match: (it: Extract<ChatItem, { kind: "user" }>) => boolean): void => {
    setItems((prev) => prev.map((it) => {
      if (it.kind !== "user" || it.pending === undefined || !match(it)) return it;
      const { pending: _, ...rest } = it;
      return rest;
    }));
  };

  // The Working bubble opens here only while the row still waits: a `consumed` that beat this IPC
  // reply already opened it (and its turn may have ended since), so a late reply mustn't reopen one.
  const deliver = async (sessionId: string, agent: LiveCli, text: string, rowId: string): Promise<void> => {
    // Undefined = sent; otherwise why not (TURN_QUEUE_FULL, an ended session) — shown inline.
    const err = await window.bean.liveSend(sessionId, text, mountId).catch(() => "Couldn't reach the agent session.");
    if (err) { clearPending((it) => it.id === rowId); addStatus(err, "error"); return; }
    setItems((prev) => (prev.some((it) => it.id === rowId && it.kind === "user" && it.pending) ? ensureStreaming(prev, sessionId, agent, newId()) : prev));
    const l = liveRef.current;
    if (l?.sessionId === sessionId) setLive({ ...l, busy: true });
  };

  // The opening turn: the transcript so far is handed over (main quotes the tail), then the text.
  // `display` = the transcript's short label for a composed skill prompt (also main's run-log label).
  // `persist` = the user chose this start (chip/slash), so its picks are remembered once it starts.
  const startSession = async (agent: LiveCli, text: string, display?: string, persist = false): Promise<void> => {
    const model = validModel(runModels, agent, agentModelRef.current);
    // The ask carries the image paths; the transcript and the run-log label stay label-only.
    const ask = withImagePaths(text, imageLabelsRef.current);
    const label = display ?? (ask !== text ? text.slice(0, LABEL_LIMIT) : undefined);
    const l: LiveState = { key: newId(), agent, projectPath: agentProjectRef.current, ...(model ? { model } : {}), turns: 0, busy: true, queued: [] };
    setLive(l);
    const history = handoffItems(itemsRef.current);
    const userId = newId();
    setItems((prev) => [...prev, { kind: "user", id: userId, text, ...(display ? { display } : {}), source: "live", pending: l.key }]);
    const res: LiveStartResult = await window.bean.liveStart({ agent, projectPath: l.projectPath, ask, history, ...(label ? { label } : {}), ...(model ? { model } : {}) }, mountId)
      .catch(() => ({ error: `${AGENT_NAMES[agent]} couldn't start.` }));
    if ("error" in res) {
      // A crash during startup already reported itself through the ended event.
      clearPending((it) => it.pending === l.key);
      if (liveRef.current?.key === l.key) { setLive(undefined); addStatus(res.error, "error"); }
      return;
    }
    knownSessionsRef.current.add(res.sessionId);
    if (persist) void persistPicks(agent, l.projectPath, model);
    const cur = liveRef.current;
    if (cur?.key !== l.key) { window.bean.liveStop(res.sessionId, mountId); return; } // ended while starting
    setLive({ ...cur, sessionId: res.sessionId, queued: [] });
    if (res.handedOver > 0) {
      const row: ChatItem = {
        kind: "status", id: newId(), tone: "info",
        text: `Handed over ${res.handedOver} message${res.handedOver === 1 ? "" : "s"}`,
        details: handoffLines(history, res.handedOver),
      };
      setItems((prev) => {
        const at = prev.findIndex((it) => it.id === userId);
        return at < 0 ? [...prev, row] : [...prev.slice(0, at + 1), row, ...prev.slice(at + 1)];
      });
    }
    for (const q of cur.queued) await deliver(res.sessionId, agent, q.text, q.rowId);
  };

  // Typed composer text in agent mode (or a `/skill` composed from it: `display` is its label,
  // `typed` the command as typed, which a failed Continue live hands back). Only this path reaches
  // an agent — loopbacks, Bean-mode skill prompts and Save to notes call sendMessage directly, so
  // they always stay Bean turns.
  const sendToAgent = (agent: LiveCli, text: string, display?: string, typed = text): void => {
    const l = liveRef.current;
    if (!l || l.agent !== agent) { void startSession(agent, text, display, true); return; }
    const rowId = newId();
    setItems((prev) => [...prev, { kind: "user", id: rowId, text, ...(display ? { display } : {}), source: "live", pending: l.key }]);
    if (!l.receipt) l.unopened?.push(typed);
    const toAgent = withImagePaths(text, imageLabelsRef.current);
    if (l.sessionId) void deliver(l.sessionId, agent, toAgent, rowId);
    else l.queued.push({ text: toAgent, rowId });
  };

  // Commands parse here only — replies, streamed agent text, loopbacks and skill prompts never
  // pass through this path.
  const onComposerSend = (raw: string, images?: ImageAttachment[]): void => {
    if (continuedTo(itemsRef.current)) return; // read-only: it lives in Discord now
    typedSinceLoadRef.current = true;
    if (!threadRef.current && !unsavableRef.current) {
      threadRef.current = { id: crypto.randomUUID(), title: threadTitle(raw) };
      onActive(threadRef.current.id);
    }
    let text = raw;
    const slash = resolveSlash(raw, modeRef.current, { agents: clis.filter(isLiveAgent), skills });
    if (slash?.kind === "ambiguous" || slash?.kind === "unknown") {
      addStatus(slash.kind === "unknown"
        ? `No skill "${slash.slug}" — check the / menu.`
        : `/${slash.slug} matches more than one skill: ${slash.names.map((n) => `"${n}"`).join(", ")} — rename one in Skills.`, "error");
      return;
    }
    if (slash?.kind === "skill") {
      const skill = skills.find((s) => s.name === slash.name)!;
      const label = `▶ ${skill.name}${slash.rest ? ` — ${slash.rest}` : ""}`;
      const live = modeRef.current;
      if (isLiveAgent(live)) {
        // Agent mode: any skill (chat or terminal target) runs in the live session — no card. Its
        // images are `[Image #N]` labels in the text (the composer stages them).
        if (skill.browser && live === "opencode") { addStatus(`"${skill.name}" needs the browser; opencode can't — switch to Claude Code or Codex.`, "error"); return; }
        sendToAgent(live, composePrompt(skill, slash.rest), label, raw);
        return;
      }
      if (skill.target !== "chat") {
        if (images?.length) { addStatus(`"${skill.name}" runs as a background agent — it takes text only.`, "error"); return; }
        runTerminalSkill(skill, slash.rest);
        return;
      }
      void sendMessage(composePrompt(skill, slash.rest), label, false, images, "skill");
      return;
    }
    if (slash?.kind === "agent") {
      const agent = slash.name as AgentId;
      if (agent !== "bean" && !clis.includes(agent)) {
        addStatus(`${AGENT_NAMES[agent]} isn't installed or is turned off in Settings.`, "error");
        return;
      }
      // `/claude <ask>` carries a pending PDF in the ask (a bare `/claude`: switchMode refills it).
      const pdfPath = isLiveAgent(agent) && slash.rest ? takePendingPdf() : undefined;
      const rest = pdfPath ? `${pdfPath} ${slash.rest}` : slash.rest;
      switchMode(agent);
      // `/claude <ask>` with Bean image chips: stage them into labels instead of dropping them.
      if (isLiveAgent(agent) && images?.length) { void sendWithImages(agent, rest, images); return; }
      if (!rest) return;
      text = rest;
    }
    const agent = modeRef.current;
    if (isLiveAgent(agent)) sendToAgent(agent, text);
    else void sendMessage(text, undefined, false, images);
  };

  // Bean's pending image chips, carried into an agent: each is staged and appended as a label. No
  // ask yet (a bare `/claude`) = the labels go back to the composer for one.
  const sendWithImages = async (agent: LiveCli, rest: string, images: ImageAttachment[]): Promise<void> => {
    let paths: string[];
    try {
      paths = await Promise.all(images.map(stageImage));
    } catch {
      addStatus(`Couldn't attach the image for ${AGENT_NAMES[agent]} — attach it again.`, "error");
      if (rest) setRefill({ text: rest });
      return;
    }
    let text = rest;
    for (const path of paths) text = insertDroppedPath(text, labelImage(path, text, agent), text.length, text.length).value;
    if (!rest) { setRefill({ text }); return; }
    sendToAgent(agent, text.trimEnd());
  };

  // Start on Bean's hand-off offer: the same handoff as `/claude <ask>` (startSession), with the
  // model's instruction as the ask line. Claimed once — a double click can't start two sessions.
  const startOffer = (id: string): void => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "offer" }> => it.kind === "offer" && it.id === id);
    const agent = offerAgent(clis);
    if (!item || item.state !== "pending" || !agent || offersClaimedRef.current.has(id)) return;
    offersClaimedRef.current.add(id);
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "offer" ? { ...it, state: "started" as const } : it)));
    endSession(AGENT_NAMES[agent]); // an older offer's Start replaces whatever session is running
    setMode(agent);
    // Scratch is "" in the window's project state (main maps it back); core sends its real path.
    // The card showed this same launch; an offer start isn't remembered.
    const launch = offerLaunch(item.offer.projectPath, agent, picksRef.current, projects, runModels);
    rememberProject(launch.projectPath);
    setAgentModel(launch.model ?? "");
    void startSession(agent, item.offer.instruction);
  };

  // Continue live on a finished delegate card or an ended live session's row: only the receipt's
  // session id goes to main, which reads the CLI and project from the recorded run. No handoff — the
  // agent has its context. The button is hidden while a session is live, and liveRef is set before
  // the await, so a double click starts one session.
  const hasLive = (): boolean => liveRef.current !== undefined; // a function, so TS keeps liveRef unnarrowed
  const continueLive = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it) => it.id === id);
    const receipt = item?.kind === "delegate" ? item.receipt : item?.kind === "status" && !item.exiting ? item.receipt : undefined;
    const sessionId = receipt?.sessionId;
    const agent = receipt?.agent;
    if (!sessionId || !agent || hasLive() || continuedTo(itemsRef.current)) return; // read-only once continued
    // A placeholder until main answers with the recorded project.
    const projectPath = item?.kind === "delegate" ? item.proposal.projectPath : agentProjectRef.current;
    // Not busy: no opening turn — it opens on the first send.
    const l: LiveState = { key: newId(), agent, projectPath, turns: 0, busy: false, queued: [], continuing: true, unopened: [] };
    const prevMode = modeRef.current;
    setLive(l);
    setMode(agent);
    const res = await window.bean.liveResume(sessionId, mountId).catch(() => ({ error: `${AGENT_NAMES[agent]} couldn't start.` }));
    if ("error" in res) {
      clearPending((it) => it.pending === l.key);
      if (liveRef.current?.key === l.key) { setLive(undefined); setMode(prevMode); addStatus(res.error, "error"); }
      return;
    }
    knownSessionsRef.current.add(res.sessionId);
    const cur = liveRef.current;
    if (cur?.key !== l.key) { window.bean.liveStop(res.sessionId, mountId); return; } // ended while starting
    setLive({ ...cur, sessionId: res.sessionId, projectPath: res.projectPath, queued: [] });
    if (projects.some((p) => p.path === res.projectPath)) rememberProject(res.projectPath);
    for (const q of cur.queued) await deliver(res.sessionId, agent, q.text, q.rowId);
  };

  // Stop / Esc Esc: end the running turn, keep the session. Main drops it if that turn already ended
  // (our `turns` is behind), and a false answer clears Stopping at once.
  const interruptTurn = async (): Promise<void> => {
    const l = liveRef.current;
    if (!l?.sessionId || !l.busy || l.stopping) return;
    setLive({ ...l, stopping: true });
    const ok = await window.bean.liveInterrupt(l.sessionId, mountId, l.turns).catch(() => false);
    const cur = liveRef.current;
    if (!ok && cur?.key === l.key && cur.stopping) setLive({ ...cur, stopping: false });
  };

  // Stop / Esc Esc for Bean's own turn: main aborts it only if this turn is still the one running;
  // its chat() then resolves `stopped` (sendMessage renders the row).
  const stopBeanTurn = (): void => {
    const t = beanTurnRef.current;
    if (!t || t.stopping) return;
    setBeanTurn({ ...t, stopping: true });
    window.bean.chatStop(mountId, t.id);
  };

  const dismissOffer = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "offer" && it.state === "pending" ? { ...it, state: "dismissed" as const } : it)));
  };

  const onLiveEvent = (e: LiveEvent): void => {
    const l = liveRef.current;
    if (e.type === "started" && l && !l.sessionId && l.agent === e.agent) {
      knownSessionsRef.current.add(e.sessionId);
      setLive({ ...l, sessionId: e.sessionId });
    }
    if (!knownSessionsRef.current.has(e.sessionId)) return;
    // A Continue live opens lazily — nothing runs until the first send (deliver opens the bubble).
    if (e.type === "started" && liveRef.current?.continuing) return;
    // Pickup: only the current session's rows clear (a late event from an ended one has no rows left).
    if (e.type === "consumed") {
      const cur = liveRef.current;
      if (cur?.sessionId === e.sessionId) setItems((prev) => consumeLive(prev, e.sessionId, cur.key, e.agent, e.count, newId()));
      return;
    }
    if (e.type === "turn" || e.type === "ended") flushRef.current = true;
    if (e.type === "turn" && hiddenRef.current) onUnread();
    setItems((prev) => applyLiveEvent(prev, e, newId));
    // Rows and mode changes only for the current session; a late event from an ended one just
    // closes its bubbles.
    const cur = liveRef.current;
    if (!cur || cur.sessionId !== e.sessionId) return;
    if (e.type === "turn") setLive({ ...cur, turns: cur.turns + 1, busy: false, stopping: false });
    // A queued follow-up starts right after the last turn's end: turn-start (or its first output) says so.
    if ((e.type === "turn-start" || e.type === "output" || e.type === "text") && !cur.busy) setLive({ ...cur, busy: true });
    if (e.type === "session") setLive({ ...cur, receipt: e.receipt });
    if (e.type !== "ended") return;
    setLive(undefined);
    clearPending((it) => it.pending === cur.key);
    setMode("bean");
    const name = AGENT_NAMES[e.agent];
    // The child has exited: the receipt's Continue live is ready at once.
    const receipt = cur.receipt ? { receipt: cur.receipt } : {};
    const row = (text: string, tone: "info" | "error"): void => setItems((prev) => [...prev, { kind: "status", id: newId(), text, tone, ...receipt }]);
    if (e.reason === "failed") row(`${name} stopped unexpectedly: ${e.error ?? "no details"}. Back to Bean.`, "error");
    // The resume never opened (rejected id): what was typed for it got no answer — hand it back.
    if (e.reason === "failed" && !cur.receipt && cur.unopened?.length) setRefill({ text: cur.unopened.join("\n\n") });
    else if (e.reason === "ended") row(`${name} session ended (idle for 30 min, or it exited). /${e.agent} starts a fresh one with this chat.`, "info");
  };

  const confirmProposal = (
    id: string,
    editedPrompt: string,
    run: RouteSuggestion,
    choice: { cli?: CliName; projectPath?: string; model?: string },
  ): void => {
    const inChat = run.target === "chat";
    if (!inChat && !choice.cli) return;
    setItems((prev) => [
      ...prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" as const } : it)),
      { kind: "status", id: newId(), text: inChat ? "Running here…" : "Handed off to Terminal.", tone: "done" },
    ]);
    if (choice.model) void window.bean.setModelMemory(run.skillName, choice.model);
    if (!inChat) rememberProject(choice.projectPath ?? "");
    if (inChat) {
      void sendMessage(editedPrompt, `▶ ${run.skillName}`, false, undefined, "skill");
      return;
    }
    window.bean.launch({
      mode: choice.cli!,
      projectPath: choice.projectPath ?? "",
      prompt: editedPrompt,
      model: choice.model,
    });
  };

  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };

  const startDelegate = async (id: string, projectPath: string, prompt: string, instruction: string, model?: string, skillName?: string, cli?: CliName): Promise<void> => {
    if (pendingDelegateStartsRef.current.has(id)) return;
    const start = window.bean.delegateStart({ projectPath, prompt, instruction, model, skillName, cli }, mountId);
    rememberProject(projectPath);
    pendingDelegateStartsRef.current.set(id, start);
    setItems((prev) => markDelegateStarting(prev, id));
    try {
      const taskId = await start;
      delegateTaskIdsRef.current.set(id, taskId);
      const buffered = pendingDelegateEventsRef.current.get(taskId) ?? [];
      pendingDelegateEventsRef.current.delete(taskId);
      const result = attachDelegateTaskId(itemsRef.current, id, taskId, prompt, buffered);
      setItems(result.items);
      for (const loopback of result.loopbacks) void sendRef.current(loopback.text, loopback.display, true, undefined, loopback.source);
    } finally {
      pendingDelegateStartsRef.current.delete(id);
    }
  };

  const confirmDelegate = async (id: string, editedPrompt: string, choice: { projectPath: string; model?: string; cli?: CliName }): Promise<void> => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    if (!item || (item.state !== "pending" && item.state !== "starting")) return;
    const { projectPath, model, cli } = choice;
    const { skillName } = item.proposal;
    if (skillName && model) {
      void window.bean.setModelMemory(skillName, model);
      setLastUsedModels((prev) => ({ ...prev, [skillName]: model }));
    }
    // The card shows (and a restore keeps) the project the run committed to. itemsRef too: the
    // start's task-id attach reads it after its await, possibly before the next render.
    const commit = (items: ChatItem[]): ChatItem[] =>
      items.map((it) => (it.kind === "delegate" && it.id === id ? { ...it, proposal: { ...it.proposal, projectPath } } : it));
    itemsRef.current = commit(itemsRef.current);
    setItems(commit);
    return startDelegate(id, projectPath, editedPrompt, item.proposal.instruction, model, skillName, cli);
  };

  // `/` terminal skill: adds a pending delegate card at the destination its menu caption named; the
  // card's Start (a second Enter — it takes focus) runs it, after the user may change project/model.
  // Browser access is main's call from skillName alone (delegate-tasks.ts), never this text.
  const runTerminalSkill = (skill: Skill, rest: string): void => {
    const dest = terminalDestination(skill.name, { projects, clis, models: runModels, delegateCli, lastUsedModels });
    const id = newId();
    const prompt = composePrompt(skill, rest);
    const instruction = `${skill.name}${rest ? ` — ${rest}` : ""}`;
    const proposal = { projectPath: dest.projectPath, instruction, skillName: skill.name, composedPrompt: prompt };
    setItems((prev) => addDelegateProposal(prev, proposal, id));
    setAutoFocusDelegateId(id);
  };

  const dismissDelegate = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "delegate" ? { ...it, state: "dismissed" as const } : it)));
  };

  const cancelDelegateTask = (id: string): void => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    const taskId = item?.taskId ?? delegateTaskIdsRef.current.get(id);
    if (taskId) window.bean.delegateCancel(taskId);
  };

  const saveNote = async (id: string, edited: ProposedNote, asNew: boolean, images?: string[]): Promise<void> => {
    try {
      const attachments = (images ?? []).map(dataUrlToAttachment).filter((a): a is ImageAttachment => a !== undefined);
      const slug = await window.bean.saveNote({
        title: edited.title,
        body: edited.body,
        project: edited.project,
        slug: asNew ? undefined : edited.slug,
        source: "chat",
      }, attachments.length > 0 ? attachments : undefined);
      // Keep the linked chip current after an in-place update (v3 → v4).
      if (!asNew && edited.slug !== undefined) {
        const fresh = (await window.bean.listNotes()).find((n) => n.slug === slug);
        if (fresh) setLinkedNote({ slug: fresh.slug, title: fresh.title, version: fresh.version, body: fresh.body });
      }
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "note" ? { ...it, state: "saved" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Saved to Notes — "${edited.title}"`, tone: "done" },
      ]);
    } catch (err) {
      let text = `Couldn't save the note: ${err instanceof Error ? err.message : String(err)}`;
      // A linked update fails once its note is archived or deleted elsewhere: unlink and point
      // at the way out. Any other failure (transient) keeps the link so a retry still updates.
      if (!asNew && edited.slug !== undefined) {
        const notes = await window.bean.listNotes({ includeArchived: true }).catch(() => undefined);
        const now = notes?.find((n) => n.slug === edited.slug);
        if (notes && (!now || now.archivedAt)) {
          const name = now?.title ?? edited.title;
          text = now ? `"${name}" is archived — restore it in Notes, or use Save as new note.` : `"${name}" was deleted — use Save as new note.`;
          if (linkedNoteRef.current?.slug === edited.slug) {
            linkedNoteRef.current = undefined;
            setLinkedNote(undefined);
          }
        }
      }
      setItems((prev) => [...prev, { kind: "status", id: newId(), text, tone: "error" }]);
    }
  };

  const dismissNote = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "note" ? { ...it, state: "dismissed" } : it)));
  };

  const saveSkill = async (id: string, edited: ProposedSkill): Promise<void> => {
    try {
      await window.bean.saveSkill(edited.name, edited.body);
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "saved" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Saved skill — "${edited.name}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissSkill = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "dismissed" } : it)));
  };

  const queueTodo = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "todo" }> => it.kind === "todo" && it.id === id);
    if (!item) return;
    try {
      await window.bean.todosAdd(item.todo.routine, item.todo.text);
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "todo" ? { ...it, state: "queued" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Queued on "${item.todo.routine}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't queue the todo: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissTodo = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "todo" ? { ...it, state: "dismissed" } : it)));
  };

  // Triggers exactly the action frozen on the card; Run now resolves only when the run ends.
  const triggerSprout = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "sprout" }> => it.kind === "sprout" && it.id === id);
    if (!item || item.state !== "pending") return;
    const settle = (result: string): void =>
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === "sprout" ? { ...it, state: "done" as const, result } : it)));
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "sprout" ? { ...it, state: "running" as const } : it)));
    const { plan } = item;
    try {
      if (plan.action === "check") settle(sproutCheckText(await window.bean.routinesCheckNow(plan.routine), plan.queuesNew));
      else {
        const res = await window.bean.routinesRunNow(plan.routine);
        settle(!res.started ? res.reason ?? "Couldn't start"
          : res.stopped ? "Stopped"
          : res.status === "failed" ? "Failed"
          : res.status === "needs-attention" ? "Needs attention"
          : "Finished");
      }
    } catch (err) {
      settle(err instanceof Error ? err.message : String(err));
    }
  };

  // Main re-resolves the picked row and posts the body it kept; the receipt names where it went.
  const confirmSend = async (id: string, optionId: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "send" }> => it.kind === "send" && it.id === id);
    if (!item || item.state !== "pending") return;
    const setState = (state: "pending" | "sending" | "sent"): void =>
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === "send" ? { ...it, state } : it)));
    setState("sending");
    try {
      const res = await window.bean.sendToDestination(item.card.id, optionId);
      if (res.ok) {
        setState("sent");
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Queued → ${res.label}`, tone: "done" }]);
        return;
      }
      setState("pending");
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't send: ${res.error}`, tone: "error" }]);
    } catch (err) {
      setState("pending");
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't send: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissSend = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "send" && it.state === "pending" ? { ...it, state: "dismissed" } : it)));
  };

  const dismissSprout = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "sprout" && it.state === "pending" ? { ...it, state: "dismissed" } : it)));
  };

  // Composer's 📝 button: an explicit ask, so the model drafts the confirm card even when it
  // wouldn't have offered on its own.
  const saveToNotes = (): void => {
    void sendMessage("Save this conversation as a note (use the propose_note tool).", "📝 Save to notes", false, undefined, "skill");
  };

  const undoMemory = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "memory" }> => it.kind === "memory" && it.id === id);
    if (!item || item.state !== "saved") return;
    const setState = (state: "saved" | "undoing" | "undone"): void =>
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === "memory" ? { ...it, state } : it)));
    setState("undoing");
    try {
      await window.bean.deleteMemories(item.saved.map((m) => m.id));
      rejectedMemoriesRef.current.push(...item.saved.map((m) => m.text));
      setState("undone");
    } catch (err) {
      setState("saved");
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  // A forget receipt's Undo: re-append the exact deleted row; restored only once the append lands.
  const undoForget = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "forgot" }> => it.kind === "forgot" && it.id === id);
    if (!item?.row || (item.state !== "saved" && item.state !== "error")) return;
    const row = item.row;
    const update = (patch: Partial<Extract<ChatItem, { kind: "forgot" }>>): void =>
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === "forgot" ? { ...it, ...patch } : it)));
    update({ state: "undoing", error: undefined });
    try {
      await window.bean.appendMemories([row]);
      // Back in memory, so close catch-up may cite it again.
      const i = rejectedMemoriesRef.current.indexOf(row.text);
      if (i >= 0) rejectedMemoriesRef.current.splice(i, 1);
      update({ state: "restored" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      update({ state: "error", error: /UNIQUE/i.test(msg) ? "a memory with this id already exists" : msg });
    }
  };

  const applyDelegateEvent = (e: DelegateEvent): void => {
    const { loopback } = applyDelegateEventToItems(itemsRef.current, e);
    if (!itemsRef.current.some((it) => it.kind === "delegate" && it.taskId === e.taskId)) {
      pendingDelegateEventsRef.current.set(e.taskId, [...(pendingDelegateEventsRef.current.get(e.taskId) ?? []), e]);
      return;
    }
    if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
      for (const [id, taskId] of delegateTaskIdsRef.current) {
        if (taskId === e.taskId) delegateTaskIdsRef.current.delete(id);
      }
      pendingDelegateEventsRef.current.delete(e.taskId);
      flushRef.current = true;
    }
    setItems((prev) => applyDelegateEventToItems(prev, e).items);
    if (loopback) void sendRef.current(loopback.text, loopback.display, true, undefined, loopback.source);
  };

  // Close-time memory for this chat, handed to main fire-and-forget — sent before the release (same
  // IPC pipe, so main sees it first). Main extracts in the background; Undo lives in Persona.
  const rememberNow = (): void => {
    const transcript = closeTranscript(itemsRef.current, typedSinceLoadRef.current);
    if (transcript.length > 0) {
      window.bean.rememberOnClose(transcript, { incognito: incognitoRef.current, rejected: rejectedMemoriesRef.current, mountId });
    }
  };

  // Anything that keeps this chat mounted when it's switched away from: a Bean request in flight or
  // queued (a loopback), a delegate starting or running, a live session, or a shell (a dev server
  // never finishes — release would kill it).
  // A Continue in Discord request awaiting the bot's ack: the chat stays mounted and a close waits
  // for it, so a thread the bot opens always gets its pointer saved here.
  const continuingRef = useRef<Promise<unknown> | undefined>(undefined);
  const hasWork = (): boolean => busyRef.current || queuedSendsRef.current.length > 0 || liveRef.current !== undefined
    || continuingRef.current !== undefined
    || shellRef.current > 0 || hasActiveDelegates(itemsRef.current, pendingDelegateStartsRef.current.size);
  const tasks = async (): Promise<ChatTasks> => {
    const terminal = shellRef.current > 0 ? await window.bean.terminalRunning(mountId).catch(() => []) : [];
    return {
      delegates: Math.max(pendingDelegateStartsRef.current.size,
        itemsRef.current.filter((it) => it.kind === "delegate" && (it.state === "starting" || it.state === "running")).length),
      ...(liveRef.current ? { live: liveRef.current.agent } : {}),
      ...(terminal.length > 0 ? { terminal } : {}),
    };
  };
  // The sidebar spinner follows the same work, from state — a live session only while its turn runs
  // (the green bar says it's open; bar without spinner = waiting for you).
  const working = busy || live?.busy === true || hasActiveDelegates(items, 0);
  useEffect(() => onWorking(working ? threadRef.current?.id : undefined), [working]);
  const isLive = live !== undefined;
  // What Stop / Esc Esc ends: the live turn first (loopbacks and skill prompts can run a Bean turn
  // beside it), otherwise Bean's own. A new key = a new turn, so ChatPanel disarms a leftover Esc.
  const stopTarget: StopTarget | undefined = live?.busy
    ? { key: `${live.key}:${live.turns}`, kind: "live", stopping: live.stopping === true }
    : beanTurn ? { key: `bean:${beanTurn.id}`, kind: "bean", stopping: beanTurn.stopping === true } : undefined;
  const onStopTurn = (): void => {
    if (stopTarget?.kind === "live") void interruptTurn();
    else if (stopTarget?.kind === "bean") stopBeanTurn();
  };
  useEffect(() => onLive(isLive ? threadRef.current?.id : undefined), [isLive]);

  // Window close: write the thread one last time (main re-checks the incognito latch), hand off memory.
  const closeOut = async (): Promise<void> => {
    await continuingRef.current;
    await saveThread();
    rememberNow();
  };

  // The final save must land (otherwise this chat stays, with an error row when shown), then memory,
  // then the shell unmounts this chat — which releases it. The composer is blocked meanwhile
  // (ChatPanel's busy); work started some other way during the save (a Plan-popup prompt, a
  // loopback) keeps it mounted instead. Resolves to whether it's gone.
  const evict = async (): Promise<boolean> => {
    if (evictingRef.current) return false;
    evictingRef.current = true;
    setEvicting(true);
    // The second write picks up anything that landed while the first was in flight (a no-op otherwise).
    const saved = (await saveThread()) && (await saveThread());
    evictingRef.current = false;
    setEvicting(false);
    if (!saved) {
      if (!hiddenRef.current) addStatus("Couldn't save this chat, so it stays open — try switching again.", "error");
      return false;
    }
    if (hasWork()) return false;
    rememberNow();
    return true;
  };

  // Off the record: leaving discards the chat (rememberNow carries the incognito flag, then the
  // unmount's chatRelease).
  const discard = (target: string): void => {
    setLeaveFlow(null);
    rememberNow();
    onSwitch(target, false);
  };

  // A sidebar row or New chat. A chat with work stays mounted, hidden; an idle one is evicted.
  const open = (target: string): void => {
    if (evictingRef.current || leavingRef.current) return;
    if (target === "new" ? !threadRef.current && itemsRef.current.length === 0 : target === threadRef.current?.id) return;
    // Discarded on leaving: off the record, or an empty chat holding a shell (no thread, so no
    // sidebar row to come back to — kept hidden, it would be unreachable).
    if (incognitoRef.current || (shellRef.current > 0 && !threadRef.current && itemsRef.current.length === 0)) {
      leavingRef.current = true;
      void tasks().then((t) => {
        leavingRef.current = false;
        const title = leaveTitle(t);
        if (title) setLeaveFlow({ switchTo: target, title });
        else discard(target);
      });
      return;
    }
    if (hasWork()) { onSwitch(target, true); return; }
    void (async () => {
      if (await evict()) onSwitch(target, false);
      else if (hasWork()) onSwitch(target, true);
    })();
  };

  // Hidden and idle again: evicted at the next switch. A failed save just stays for the next try;
  // shown again meanwhile (the user picked it) = it stays.
  const sweep = (): void => {
    if (!hiddenRef.current || hasWork()) return;
    void evict().then((gone) => { if (gone && hiddenRef.current) onEvicted(); });
  };

  const stopTasks = async (): Promise<void> => {
    await Promise.allSettled(pendingDelegateStartsRef.current.values());
    const cancelled = new Set<string>();
    for (const taskId of delegateTaskIdsRef.current.values()) {
      cancelled.add(taskId);
      window.bean.delegateCancel(taskId);
    }
    for (const it of itemsRef.current) {
      if (it.kind !== "delegate" || (it.state !== "starting" && it.state !== "running")) continue;
      const taskId = it.taskId ?? delegateTaskIdsRef.current.get(it.id);
      if (taskId && !cancelled.has(taskId)) {
        cancelled.add(taskId);
        window.bean.delegateCancel(taskId);
      }
    }
    // The session dies with its chat anyway (main's stopMount/stopOwner); stopping now is just
    // sooner, and leaves its Continue live row in the transcript.
    endSession();
    // Likewise every tab's shell (release stops them): resolves once they and their jobs are gone.
    if (shellRef.current > 0) await window.bean.terminalStop(mountId).catch(() => undefined);
  };

  // Rendered into the shell's registry, so its once-registered listeners reach this chat. Removed
  // at unmount.
  sessions.set(mountId, {
    mountId,
    delegateEvent: applyDelegateEvent,
    liveEvent: onLiveEvent,
    threadId: () => threadRef.current?.id,
    renamed: (title) => { if (threadRef.current) threadRef.current = { ...threadRef.current, title }; },
    memoryUpdated: (saved) => setItems((prev) => [...prev, { kind: "memory", id: newId(), saved, state: "saved" }]),
    // generate_image started inside the current turn — flip the working bubble so the
    // (up to a minute) wait reads as painting, not a hang.
    imageProgress: () => {
      if (beanTurnRef.current?.stopping) return; // the row is on its way out
      setItems((prev) => prev.map((it) => (it.kind === "working" ? { ...it, text: "🎨 Painting" } : it)));
    },
    runPrompt,
    // Rendered as a `reply` (not `status`) so it enters conversation history: a later "retry" needs
    // the full instruction (notice.text) in context, not just the short bubble text (notice.display).
    notices: (notices) => setItems((prev) => [
      ...prev,
      ...notices.map((n) => ({ kind: "reply" as const, id: newId(), text: n.text, display: n.display })),
    ]),
    open,
    error: (text) => addStatus(text, "error"),
    tasks,
    stopTasks,
    closeOut,
    sweep,
    toggleTerminal,
    terminalShortcut: (sc) => terminalShortcutRef.current?.(sc),
  });
  useLayoutEffect(() => () => { sessions.delete(mountId); }, []);

  // Continue in Discord (#697): main stops an agent session and waits for its exit before the bot
  // resumes it; a plain chat carries its recent messages. On ok or partial the pointer is saved at
  // once and the window switches to the thread's synced view.
  const continued = continuedTo(items);
  const continueDisabled = !discordBot ? "Start the Discord bot in Settings first."
    : busy || evicting || live?.busy ? "Wait for the current turn to finish."
    : incognito ? "Off-the-record chats stay on this Mac."
    : continued ? "Already continued in Discord."
    : live && !live.sessionId ? "The agent session is still starting."
    : !threadRef.current || !items.some((it) => it.kind === "user" || it.kind === "reply") ? "Nothing to continue yet."
    : undefined;
  const continueChat = async (channelId: string, title: string): Promise<string | undefined> => {
    if (continuingRef.current) return "Already continuing.";
    const l = liveRef.current;
    const request = window.bean.deskContinue(
      l?.sessionId ? { channelId, title, sessionId: l.sessionId } : { channelId, title, history: handoffItems(itemsRef.current) },
      mountId,
    ).catch((err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }));
    continuingRef.current = request;
    let res: Awaited<typeof request>;
    try {
      res = await request;
      const r = res;
      const moved = !("failed" in r) && !("refused" in r);
      // The session was stopped for a move that didn't happen: Continue live picks it up here.
      const stranded = !moved && l?.receipt && liveRef.current === undefined ? l.receipt : undefined;
      const note: ChatItem | undefined = l && moved ? { kind: "status", id: newId(), text: `${AGENT_NAMES[l.agent]} moved to Discord.`, tone: "info" }
        : l && stranded ? { kind: "status", id: newId(), text: `${AGENT_NAMES[l.agent]} stopped — it didn't move to Discord.`, tone: "info", receipt: stranded }
        : undefined;
      const pointer = moved ? continuedRows(r.threadId, title, "partial" in r) : [];
      const apply = (items: ChatItem[]): ChatItem[] => [...(moved ? expirePending(items) : items), ...(note ? [note] : []), ...pointer];
      // The ref first: a close waiting on this request saves what it reads there.
      itemsRef.current = apply(itemsRef.current);
      setItems(apply);
    } finally {
      continuingRef.current = undefined;
    }
    flushRef.current = true;
    if ("failed" in res) return res.failed;
    if ("refused" in res) return continueRefusal(res.refused);
    if (l) setMode("bean");
    if (!hiddenRef.current) onOpenSynced(res.threadId);
    return undefined;
  };

  const stopAndDiscard = async (): Promise<void> => {
    const switchTo = leaveFlow?.switchTo;
    if (switchTo === undefined) return;
    await stopTasks();
    discard(switchTo);
  };

  return (
    <>
      {leaveFlow && !hidden ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">{leaveFlow.title}</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => setLeaveFlow(null)}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void stopAndDiscard()}>Stop & switch</button>
            </div>
          </div>
        </div>
      ) : null}
      <ChatPanel
        hidden={hidden}
        mountId={mountId}
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        onTerminalOpen={setTerminalOpen}
        onShells={onShells}
        terminalShortcut={terminalShortcutRef}
        items={items}
        busy={busy || evicting}
        model={model}
        status={status}
        prefillUrl={prefillUrl}
        refill={refill}
        linkedNote={linkedNote}
        clis={clis}
        projects={projects}
        runModels={runModels}
        lastUsedModels={lastUsedModels}
        skills={skills}
        delegateCli={delegateCli}
        onSlashOpen={refreshCatalogs}
        onSend={onComposerSend}
        pdf={pdf ? { filename: pdf.filename, size: pdf.size, sent: pdf.sent } : undefined}
        onAttachPdf={attachPdf}
        onRemovePdf={removePdf}
        imageLabels={imageLabelsRef.current}
        onImageLabel={labelImage}
        onStageImage={stageImage}
        mode={mode}
        agentProject={agentProject}
        agentModel={isLiveAgent(mode) ? validModel(runModels, mode, agentModel) ?? "" : ""}
        live={live ? { agent: live.agent, projectPath: live.projectPath, model: live.model, busy: live.busy, continuing: live.continuing, stopping: live.stopping } : undefined}
        offerLaunch={(offerPath) => {
          const agent = offerAgent(clis);
          return agent ? offerLaunch(offerPath, agent, picks, projects, runModels) : { projectPath: offerPath };
        }}
        onPickAgent={switchMode}
        onPickProject={pickProject}
        onPickModel={pickModel}
        onEndAgent={() => { endSession("Bean"); setMode("bean"); }}
        stopTarget={stopTarget}
        onStopTurn={onStopTurn}
        onConfirm={confirmProposal}
        onCancel={cancelProposal}
        onNoteSave={(id, edited, asNew, images) => void saveNote(id, edited, asNew, images)}
        onNoteDismiss={dismissNote}
        onSkillSave={(id, edited) => void saveSkill(id, edited)}
        onSkillDismiss={dismissSkill}
        onTodoQueue={(id) => void queueTodo(id)}
        onTodoDismiss={dismissTodo}
        onSproutTrigger={(id) => void triggerSprout(id)}
        onSproutDismiss={dismissSprout}
        onSendConfirm={(id, optionId) => void confirmSend(id, optionId)}
        onSendDismiss={dismissSend}
        onOfferStart={startOffer}
        onOfferDismiss={dismissOffer}
        onDelegateConfirm={(id, edited, choice) => void confirmDelegate(id, edited, choice)}
        autoFocusDelegateId={autoFocusDelegateId}
        onDelegateDismiss={dismissDelegate}
        onDelegateCancelTask={cancelDelegateTask}
        onContinueLive={(id) => void continueLive(id)}
        onSaveToNotes={saveToNotes}
        onUnlink={() => setLinkedNote(undefined)}
        incognito={incognito}
        onToggleIncognito={toggleIncognito}
        continueButton={(
          <ContinueDiscord
            disabled={continueDisabled}
            title={threadRef.current?.title ?? ""}
            agent={live?.sessionId ? live.agent : undefined}
            count={Math.min(handoffItems(items).filter((h) => h.text.trim()).length, HANDOFF_ITEMS)}
            onContinue={continueChat}
          />
        )}
        continued={continued ? { title: continued.title } : undefined}
        onOpenContinued={continued ? () => onOpenSynced(continued.conversationId) : undefined}
        onMemoryUndo={(id) => void undoMemory(id)}
        onForgetUndo={(id) => void undoForget(id)}
      />
    </>
  );
}
