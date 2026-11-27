import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChatopsActivitySink } from "./activity.js";
import { converse, speakerLine, type ChatTurn, type ConverseDeps, type ConverseResult, type ImageAttachment, type ProposedDelegate, type ProposedLiveSession, type ProposedSend } from "../converse.js";
import { makeGenerateImageTool, type ImageGenDeps } from "../image-gen.js";
import { composePrompt, delegateOutcomeRecord, delegateOutcomeTurn, trimDelegateFinal, type DelegateOutcome } from "../prompt.js";
import { stageImages } from "../stage-images.js";
import { makeMemoryTools, saveScope } from "../memory/tools.js";
import { extractMemories, memoryCategories } from "../memory/extract.js";
import { makeReminderTools, reminderInConversation } from "./reminder-tools.js";
import { makeTodoTools } from "./todo-tools.js";
import { makeBackgroundWorkTool } from "../background-work.js";
import { makeSproutReadTools } from "../sprout-read-tools.js";
import type { Dispatch } from "../dispatch-store.js";
import {
  chatRoutineProblem, draftNames, foldOwnerDmSinks, hasEnded, isArchived, isExpired, isOwnerDmSink, todoRunHint, untilLabel, type Routine,
} from "../routine-store.js";
import { destinationLabel, matchDestination, type Destination, type DestinationKey } from "../destinations.js";
import type { OutboxMessage } from "../outbox.js";
import type { TodoItem } from "../todo-store.js";
import type { SproutTriggerClient } from "./sprout-bridge.js";
import { homeDestination, planSproutRun, sproutCheckText, type HomeDms, type SproutRunBlock } from "../sprout-trigger.js";
import { CARD_LEAD, cardRecord, type CardRecordKind, type CardRecordState } from "../card-record.js";
import type { SproutRunProposalStore } from "./sprout-run-proposals.js";
import type { SendProposalStore } from "./send-proposals.js";
import { cancelReminder } from "../reminders.js";
import { availableModels } from "../models.js";
import type { Skill, Project } from "../types.js";
import type { Persona } from "../persona.js";
import type { Memory } from "../memory/memory.js";
import type { RecallScope } from "../memory/store.js";
import type { CliName } from "../launcher.js";
import { cliOffersModel, resolveWireModel, type CliModels } from "../cli-models.js";
import { OPENCODE_BROWSER_REFUSAL, type DelegateRequest } from "../delegate.js";
import {
  createGrant, followUpNote, followUpRefusedNote, followUpRefusedText, GRANT_MISMATCH_TEXT, matchFollowUp, matchGrant,
  refreshGrant, reserveFollowUp, revokeGrant, type DelegateGrant,
} from "../delegate-grant.js";
import type { TurnCap } from "./turn-cap.js";
import { BAD_SESSION_ID, isLiveSessionId, isValidSessionId, resumeCommand, type DelegateRunRow, type ResumableRun } from "../delegate-runs.js";
import { LIVE_CLIS, isLiveCli, type LiveCli } from "../live-session.js";
import { TURN_QUEUE_FULL } from "../turn-live-session.js";
import { lastSaidLine, skillBrowserChange, type CardBuilders, type NoContinueReason } from "./cards-api.js";
import { formatAmbientBlock, formatCarriedBlock, formatRepliedBlock, REPLIED_UNAVAILABLE, type AmbientMessage, type RepliedMessage } from "./ambient.js";
import { memoryUpdatesFor, resolveCliModel } from "./resolve.js";
import type { ConversationStore } from "./conversation.js";
import type { ChatopsSurface, ConversationCatalog, ConversationPlace } from "./catalog.js";
import { MAIN_CONVERSATION_ID } from "../main-conversation.js";
import { MAX_DESK_TEXT, type DeskAckResult, type DeskContinueBody, type DeskContinueResult, type DeskRefusal } from "./desk.js";
import { boundMainLog, maybeCompact } from "./compact.js";
import { MAX_INSTRUCTION_CHARS, type PendingProposal, type ProposalStore } from "./proposals.js";
import type { NoteProposalStore } from "./note-proposals.js";
import type { NoteArchiveProposalStore } from "./note-archive-proposals.js";
import type { TodoProposalStore } from "./todo-proposals.js";
import type { SkillProposalStore } from "./skill-proposals.js";
import {
  ownerDraftNotice, parseRoutineCommand, routineCardInput, routineListText, type RoutineCommand, type RoutineProposalStore,
} from "./routine-proposals.js";
import { retrieveNoteTool, type Note, type NoteDraft } from "../note-store.js";
import { attachNoteImages } from "../note-images.js";
import { systemControlTool } from "../system-control.js";
import type { RunDelegateFn, RunRegistry } from "./runs.js";
import { LiveSessionProposalStore, type PendingLiveSession } from "./live-session-proposals.js";
import { LiveSessionRegistry, type LiveSessionSink } from "./live-sessions.js";
import {
  atLeast, can, cardActionNeeds, cardTapRefusal, dmAllowed, dmRefusal, needs, parseRoleCommand, refusal, roleLine,
  routineAdminRefusal, routineDraftRefusal,
  type Capability, type Role, type Roles,
} from "./roles.js";
import { makeAmbientCapture, type AmbientLine } from "./ambient-capture.js";
import { awayLine, awayRefusal, awayReminder, awaySuggestion, parseAwayCommand, runAwayCommand, type Away } from "./away.js";
import { makeAwayPrepare } from "./away-prepare.js";
import { NOT_CHATTY, formatMuteEnd, makeChimeIn, parseChatterCommand, type Chatter, type ChatterCommand, type ChimeInFx } from "./chatter.js";

/** Only messages that explicitly address the bot (DM, @mention, or reply-to-bot) reach
 * onMessage — surfaces keep untagged channel chatter as ambient context instead. */
export interface IncomingMessage {
  conversationId: string;
  text: string;
  /** Set when `text` also carries non-typed content (Discord appends audio transcripts, which may
   * be a third party's recording): only this part is the sender's own words for remember.
   * Absent = all of `text` was typed. */
  typedText?: string;
  fromId: string;
  /** Teams' AAD object id — the owner may be configured by either id. */
  fromAltId?: string;
  fromName: string;
  /** Admin scope: the channel or group chat (a thread's parent channel), not the thread.
   * Absent = no admins apply. Ignored for DMs, which never have admins. */
  scopeId?: string;
  /** A 1:1 DM with the bot (the guest-DM gate applies). */
  direct: boolean;
  /** @mentions (excluding the bot) with display names — `add-admin` / `remove-admin` targets. */
  mentions?: { id: string; name: string }[];
  /** User-ids @mentioned in this message (excluding the bot), if the surface supplies them —
   * used by the live-session `+driver`/`-driver` commands. Surfaces that omit it can't use
   * mention-based co-driver management. */
  mentionedIds?: string[];
  /** Human channel label for the desktop status bubble ("#general", "DM"); never message text. */
  channelName?: string;
  /** Image attachments (image/*, ≤10MB) already downloaded by the surface — attached to this
   * turn only; history keeps a text placeholder. */
  images?: ImageAttachment[];
  /** The message this one replies to, if any. Context only: it never feeds `text`/`typedText`,
   * command parsing, remember citations, or the role check. */
  repliedTo?: RepliedMessage;
  /** The live session (`LiveSessionRegistry.generation`) the surface saw capturing this
   * conversation, before its downloads. If that session ended (or was replaced) meanwhile, the
   * message is dropped — it was meant for that session, never for a Bean turn. */
  liveRun?: string;
}

const NO_RUN_RECORD = "I have no record of that run.";
const liveBusyLine = (cli: LiveCli): string => `A ${cli} session is already running here — \`stop\` it first.`;

export interface CardAction {
  conversationId: string;
  /** Surface user-id of whoever tapped the card — the role check's identity (empty = guest), and
   * the live-session start path's session owner. */
  fromId: string;
  fromAltId?: string;
  /** Admin scope of the tapped card's channel (see IncomingMessage.scopeId). */
  scopeId?: string;
  fromName: string;
  /** The tapped card's conversation as the surface sees it — feeds the owner's conversation
   * catalog when a live session starts. Absent = not catalogued. */
  place?: ConversationPlace;
  /** The tapped card is in a real 1:1 DM with the bot — derived by the adapter (Teams `isDirect`,
   * Discord `isDMBased()`), never from an absent `scopeId`. Send actions refuse unless true. */
  direct?: boolean;
  value: {
    beanAction?: string; proposalId?: string; projectPath?: string; runId?: string; cli?: string; model?: string; skillName?: string;
    steering?: string; instruction?: string;
    /** A send card's picked option id (Teams' ChoiceSet, Discord's select) — re-checked against the proposal. */
    destination?: string;
  };
}

export interface BotEffects {
  reply: (text: string) => Promise<void>;
  postCard: (card: object) => Promise<string>;
  updateCard: (activityId: string, card: object) => Promise<void>;
  post: (text: string) => Promise<void>;
  /** Ambient channel messages (not addressed to Bean) since the given epoch ms, oldest first. */
  fetchRecent?: (sinceMs: number) => Promise<AmbientMessage[]>;
  /** Post a plain-text message and return its id; edit it in place. The live-session stream
   * sink uses these. Optional: surfaces that omit them fall back to postCard/updateCard with
   * `{content}` (correct on Discord, whose postCard takes plain message options — but NOT on
   * Teams, where postCard is adaptive-card-only, so Teams must supply real text effects here). */
  postStream?: (text: string) => Promise<string>;
  editStream?: (id: string, text: string) => Promise<void>;
  /** Fire a one-shot "typing…" indicator. The live-session sink pings this repeatedly while a
   * turn runs so the surface shows Bean working during the agent's think/stream gap. Optional. */
  sendTyping?: () => void;
  /** Deliver a local file (generated image) to the conversation. Optional: surfaces without it
   * get a plain-text path notice instead. */
  sendFile?: (path: string, caption?: string) => Promise<void>;
  /** Deliver a delegate run's result — the late answer to an earlier turn. Optional, falls back
   * to `post`; Discord uses it to speak the result when that turn was a voice message. Not
   * `reply`: Teams' reply rides the original turn context, long gone by the time a run ends. */
  postResult?: (text: string) => Promise<void>;
  /** A public receipt (a real admin change) on surfaces where `reply` may be private. Optional,
   * falls back to `reply`. */
  announce?: (text: string) => Promise<void>;
}

export interface TeamsBotDeps {
  chat: ConverseDeps["chat"];
  model: string;
  /** Recall by meaning for turns and chime-ins (core makeRankByMeaning); absent = keyword recall. */
  rankByMeaning?: ConverseDeps["rankByMeaning"];
  loadSkills: () => Promise<Skill[]>;
  loadProjects: () => Promise<Project[]>;
  loadPersona: () => Promise<Persona>;
  /** Scoped like core's loadMemories: absent = all, `null` = household-shared only, an id (or
   * list) = shared plus those speakers' private facts. */
  loadMemories: (subject?: string | string[] | null, scope?: RecallScope) => Promise<Memory[]>;
  /** Every id the owner's private facts live under, across surfaces (core `ownerSubjectIds`).
   * The owner's DM recalls and dedupes against all of them; absent = just the speaker's id. */
  ownerSubjectIds?: () => Promise<string[]>;
  loadModelMemory: () => Promise<Record<string, string>>;
  saveModelMemory: (m: Record<string, string>) => Promise<void>;
  detectClis: () => CliName[];
  cliModels: CliModels[]; // clis.json (repo default + ~/.bean override), refilled in place on edit
  runs: RunRegistry;
  proposals: ProposalStore;
  noteProposals: NoteProposalStore;
  /** Persists a confirmed note to the shared bean.db (server injects the db path). */
  saveNote: (draft: NoteDraft) => Promise<string>;
  /** Stores one image in bean.db's note_images (server injects the db path). Enables carrying
   * chat images into a saved note and the generate_image embed hint; omit to disable both. */
  saveNoteImage?: (bytes: Uint8Array) => Promise<string>;
  /** FTS5 search over saved notes (server injects the db path); backs retrieve_note. */
  searchNotes: (query: string) => Promise<Note[]>;
  /** Confirm-first propose_note_archive: the pending archive, the archive itself (false = already
   * archived or gone) and the receipt's Restore (never creates — see restoreNoteOutcome). */
  noteArchiveProposals: NoteArchiveProposalStore;
  archiveNote: (slug: string) => Promise<boolean>;
  restoreNote: (slug: string) => Promise<"restored" | "live" | "missing">;
  todoProposals: TodoProposalStore;
  /** Queues a confirmed todo (server injects the db path + routine validation). `createdBy` set =
   * a non-owner's todo: the routine must be `memberTodoEligible` and the row is stamped with it.
   * Returns the routine queued on (for the receipt's "when"). */
  queueTodo: (routine: string, text: string, createdBy?: string) => Promise<Routine | void>;
  /** Queues a confirmed todo with its dispatch row (#923), so its result is posted back to `report`
   * (`channel` absent = the owner's DM) when it runs. `front` = Run now (ahead of every queued todo).
   * Absent = queued todos don't report back. */
  queueTodoDispatch?: (t: { routine: string; text: string; createdBy?: string; front?: boolean }, report: { channel?: string; actor?: string })
    => Promise<{ routine?: Routine; jobId: string; ahead: number }>;
  /** A routine's pending todos, for the card's "N ahead in queue". */
  pendingTodos?: (routine: string) => Promise<number>;
  /** Names of routines with todoDriven=true — gates the propose_todo tool. `member` = only
   * `memberTodoEligible` ones (no delegate or command steps). */
  listTodoRoutines: (member: boolean) => Promise<string[]>;
  /** Backs list_todos / cancel_todo: `createdBy` set = only that speaker's rows (SQL-filtered). */
  listOpenTodos: (createdBy?: string) => Promise<TodoItem[]>;
  cancelTodo: (id: string, createdBy?: string) => Promise<boolean>;
  /** Backs background_work (#924): bean.db, the sprouts' state file, and this conversation's
   * dispatches (`conversation` absent = the owner DM). Absent = the tool isn't offered. */
  backgroundWork?: { file: string; stateFile: string; dispatches: (conversation?: string) => Dispatch[] };
  skillProposals: SkillProposalStore;
  /** Persists a confirmed skill draft to the user's ~/.bean/skills (server injects the dir). */
  saveSkill: (name: string, body: string) => Promise<void>;
  /** Insert-only add of new facts — never lose a concurrent writer's addition (see
   * memory/store.ts's appendMemories doc comment). */
  appendMemories: (additions: Memory[]) => Promise<void>;
  /** Idempotent per-id delete (remember card's Forget button, forget_memory tool). `subject`
   * set = only that speaker's private rows may go (non-owners); absent = any row (the owner). */
  deleteMemories: (ids: string[], subject?: string) => Promise<string[]>;
  /** Share button on a private receipt: only the row's author (`actor`) can make it household-shared. */
  shareMemory: (id: string, actor: string) => Promise<number>;
  /** Config `autoMemory`, read per turn (no restart): gates DM auto-capture only, never the
   * explicit remember/forget tools. Absent = off. */
  autoMemoryEnabled?: () => Promise<boolean>;
  conversations: ConversationStore;
  /** The owner's continuable conversations (owner DMs, owner-started live sessions) for the
   * desktop. Omit = nothing catalogued. */
  catalog?: ConversationCatalog;
  /** One conversation (#998): once `cutover()` (the main log's marker, #997) holds, the owner's
   * real 1:1 DM keeps its model history in the main conversation's log, tagged `surface`. Absent =
   * never (every DM keeps its own history). */
  mainLog?: { surface: ChatopsSurface; cutover: () => boolean };
  cards: CardBuilders;
  /** Gates the system_control action tool, same as main.ts's desktop wiring. */
  systemControlsEnabled: () => boolean;
  /** Config `webSearch`: offer converse() the built-in public web search. */
  webSearchEnabled?: () => boolean;
  /** Active chat-bridged agent sessions; while a channel is bound, its messages bypass converse. */
  liveSessions: LiveSessionRegistry;
  /** Where a steer's images are staged for the agent to read by path, one subdir per
   * conversation. Default `<os.tmpdir()>/bean-live-images`; files are left for the OS purge. */
  liveImagesDir?: string;
  liveSessionProposals: LiveSessionProposalStore;
  /** Gates the propose_live_session tool (surface support, e.g. a live-capable CLI is present). */
  liveSessionsEnabled: () => boolean;
  /** delegate_runs lookup behind Continue live (server injects the db path). Omit = no record.
   * `surface: "desktop"` looks up only desktop rows (desk-continue's agent mode, #696). */
  findDelegateRun?: (sessionId: string, surface?: "desktop") => ResumableRun;
  /** Appends a delegate_runs row (recordDelegateSession); false = not written. Desk-continue moves
   * a desktop session here by appending this surface's row. Omit = nothing can move. */
  recordDelegateRun?: (row: DelegateRunRow) => boolean;
  /** Working dir for delegates not tied to a project (must exist); omit to require a project. */
  scratchPath?: string;
  /** Enables the generate_image action tool; omit to disable image generation. */
  imageGen?: Pick<ImageGenDeps, "generate" | "model" | "imagesDir">;
  /** Bean's turns (converse path only) for the desktop app's status bubbles (see activity.ts). */
  onActivity?: ChatopsActivitySink;
  /** The surface's daily turn cap (Discord): Bean's turn on a delegate's end (#1133) counts against
   * the person it answers for, like their own turn would (never the owner). Absent = uncapped. */
  turnCap?: Pick<TurnCap, "admit">;
  /** Enables the chatops reminder tools (member+): reminders.json path plus this surface's
   * outbox transport. Teams targets are always the asking conversation (its outbox can't DM
   * a specific user); Discord DMs target the speaker. */
  reminders?: { file: string; transport: "discord" | "teams" };
  /** Owner-DM sends (#689): propose_send is offered only in the owner's real DM with the bot,
   * resolving names among this surface's destinations. Absent = never offered. */
  send?: {
    transport: "discord" | "teams";
    destinations: () => Destination[];
    enqueue: (msg: Pick<OutboxMessage, "transport" | "channel" | "body">) => Promise<unknown>;
    proposals: SendProposalStore;
  };
  /** Owner / admin / guest — required, no permissive default (see .memory/safety-chatops-roles.md). */
  roles: Roles;
  /** Owner routine management (#285): propose_routine plus the `routines` / `enable <name>` /
   * `disable <name>` commands; admins draft only (#322). Omit on surfaces that don't support it.
   * `save` writes as given (callers validate); `create` is the create-only save for non-owner
   * drafts (throws `EEXIST` on a clash); `notifyOwner` DMs the owner (no channel);
   * `recipients` = the owner and household members a routine may DM; `transport` = this
   * surface, the only chatops sink transport a draft may use. */
  /** Per-channel chime-in setting and mute (`chatty on|off|status`, `quiet 30m`, `unmute`).
   * Absent = those words are ordinary turns. */
  chatter?: Chatter;
  /** The owner's away mode on this surface (`away on|off|status`, owner's real DM only, #903).
   * Absent = those words are ordinary turns. */
  away?: Away;
  /** The executor for away-mode prepare runs (#909; `runDelegate`). Absent = no prepares: the
   * suggestion call offers no `prepare` tool. */
  awayPrepareRun?: RunDelegateFn;
  routines?: {
    transport: "discord" | "teams";
    load: () => Promise<Routine[]>;
    save: (routine: Routine) => Promise<void>;
    create: (routine: Routine) => Promise<void>;
    notifyOwner: (text: string) => Promise<void>;
    recipients: () => Promise<{ id: string; name: string }[]>;
    /** Named chat destinations, so a draft's alias sink is checked as the conversation it names.
     * Absent = an alias sink is refused as unknown. */
    destinations?: () => Destination[];
    /** Cards name the owner DMs a Home post is copied to (#1069), read live; absent = none. */
    homeDms?: () => Promise<HomeDms | undefined>;
    proposals: RoutineProposalStore;
    /** Run or check a sprout now (#636) — where this process owns the scheduler (headless
     * Discord) or asks the app that spawned it over IPC (#637, `parentSproutTrigger`). `trigger`
     * answers at admission; the scheduler host records the dispatch and posts the finish reply to
     * `origin` (`channel` absent = the owner's DM), across a restart (#919). Absent = propose_sprout_run is never offered. */
    sprouts?: {
      /** `todo` = Run now for the todo queued as `job` (#923). */
      trigger: SproutTriggerClient;
      /** A sprout's pending todos and whether its watch is seeded, for planSproutRun. */
      facts: (routine: Routine) => Promise<{ pending: number; seeded: boolean }>;
      proposals: SproutRunProposalStore;
      /** Live run slots per sprout, from the scheduler host (`parentSproutRunning`); undefined = unknown. */
      running?: () => Promise<{ name: string; runs: number }[] | undefined>;
    };
  };
}

/** Home is the owner's own chat with Bean: only the owner's draft in their 1:1 (`ownerDm`) may set
 * it, and its owner-DM chat sinks become Home (#1070). Elsewhere a draft loses `home` and any
 * owner-DM chat sink, which would fold into Home on save (#1068). */
export function draftHome(r: Routine, ownerDm: boolean): Routine {
  if (ownerDm) return { ...r, sinks: foldOwnerDmSinks(r.sinks) };
  const { home: _home, chatops, ...rest } = r.sinks;
  const kept = chatops?.filter((c) => !isOwnerDmSink(c));
  return { ...r, sinks: { ...rest, ...(kept && kept.length > 0 ? { chatops: kept } : {}) } };
}

const SPROUT_BLOCKED: Record<SproutRunBlock, (name: string) => string> = {
  off: (name) => `${name} is off — say \`enable ${name}\` first.`,
  review: (name) => `${name} needs its first review in Bean's Sprouts panel.`,
  empty: (name) => `${name}'s queue is empty — queue a todo first.`,
};

const SEND_KIND: Record<Destination["kind"], string> = { channel: "channel", thread: "thread", group: "group chat", meeting: "meeting chat", dm: "DM" };
const SEND_EXPIRED = "That send card expired — ask me again.";
/** The longest body a send card shows in full (Discord's embed description caps at 4096). */
export const MAX_SEND_CHARS = 4000;

/** `continue`'s answer per refusal; the rest fall back to a generic line. */
const MAIN_CONTINUE_NONE = "There's no agent session to continue here.";

const CONTINUE_REFUSED: Partial<Record<DeskRefusal, string>> = {
  "no-record": "There's no ended live session here to continue.",
  "channel-busy": "A live session is already running here.",
  "cli-missing": "That session's CLI isn't installed on this Mac any more.",
};

const nameTaken = (name: string): string => `a sprout named "${name}" already exists — ask for a different name.`;

const DESKTOP_ONLY =
  "That needs the Bean desktop app — from here I can only chat and run background delegate tasks. Ask me again and I'll run it as one.";
const NO_CLI = "I can't run delegate tasks: no supported CLI (`claude`, `opencode`, `codex`, or `agy`) is available on this machine.";

/** The session id in `/live-session resume <rest>`. Pasted `claude --resume <id>`,
 * `codex resume <id>`, `opencode -s <id>` / `--session <id>` and `agy --conversation <id>` spans win (also inside a routine
 * digest's footer line), all merged before the one-id check; otherwise every valid-looking token
 * counts, and exactly one is required. */
export function parseResumeArg(rest: string): { id: string } | { error: string } {
  const flagged = [...rest.matchAll(/(?:\bresume|(?<![^\s`])(?:-s|--session|--conversation))\s+`?([^\s`]+)/g)].map((m) => m[1] ?? "");
  const candidates = flagged.length > 0 ? flagged : rest.replace(/`/g, " ").split(/\s+/);
  const ids = [...new Set(candidates.filter(isValidSessionId))];
  if (ids.length === 0) return { error: BAD_SESSION_ID };
  if (ids.length > 1) return { error: "Send just one session id." };
  return { id: ids[0]! };
}

/** Whom a delegate run answers to (#1133): the confirming tap's — or the continuing turn's — platform
 * identity (never a display name for authority), re-checked before Bean follows up on its own. */
interface RunActor { id: string; altId?: string; scopeId?: string; name: string }

/** Why Bean's automatic follow-up didn't run (#1133), closing its one final message. */
const FOLLOW_UP_REPLIED = "Follow-up skipped — you replied, so I'll go with that instead.";
const FOLLOW_UP_CAPPED = "Follow-up skipped — daily limit reached.";

export function buildTeamsBot(deps: TeamsBotDeps): {
  onMessage: (msg: IncomingMessage, fx: BotEffects) => Promise<void>;
  onCardAction: (action: CardAction, fx: BotEffects) => Promise<void>;
  /** One CHATOPS_COMMANDS command, for surfaces that invoke it directly (a slash menu) rather
   * than as typed text. true = handled (answered or refused); false = not a command. */
  onCommand: (msg: IncomingMessage, fx: BotEffects) => Promise<boolean>;
  /** Explicit /live-session entry: validate + post the same confirm card the LLM path posts.
   * Returns a short line for the invoker (surface shows it as an ephemeral ack). */
  proposeLiveSession: (
    args: { conversationId: string; instruction: string; proposedBy: string },
    fx: BotEffects,
  ) => Promise<string>;
  /** An un-addressed message in a channel conversation (scope = its channel): may lead to a
   * text-only chime-in after a lull, if `chatty on` there, and feeds household memory capture
   * (#463, unless `memory off` there or config `autoMemory` is off). No-op without `deps.chatter`. */
  onAmbient: (conversationId: string, scopeId: string, fx: ChimeInFx, line: AmbientLine) => void;
  /** A message addressed to Bean in a channel, group chat or thread (not a DM, not a live
   * session) that may also tag the owner: the away-mode record + fixed line only (#904) — the
   * ambient path runs the same check itself. `post` lands in the message's own conversation and
   * never pings. Never rejects. */
  onAwayTag: (conversationId: string, line: AmbientLine, post: (text: string) => Promise<void>) => Promise<void>;
  /** Synchronous, for shutdown: stops a running away prepare and marks it interrupted (#909). */
  interruptAwayPrepares: () => void;
  /** A turn the owner typed at the desktop (desk ingress, chatops/desk.ts). Checks the catalog,
   * posts the `🖥 (desk):` echo, then runs it as the owner's turn — or steers the running live
   * session. `ack` is called exactly once, as soon as the turn is accepted or refused (before the
   * turn's work); the promise settles when the turn is done. `effects` resolves the platform's
   * proactive effects for the conversation, and is only called once the request is eligible. */
  onDeskTurn: (
    req: { conversationId: string; text: string },
    effects: () => Promise<{ fx: BotEffects; scopeId?: string }>,
    ack: (r: DeskAckResult) => void,
  ) => Promise<void>;
  /** The owner's desk Continue live: reopens the conversation's ended owner-started live session
   * with no card — the desk click is the confirmation. CLI, session id and project come from the
   * catalog row and `findDelegateRun`, never the request. Starts restricted, steered by the
   * catalog's owner id, and posts the mode line so the channel sees it reopen. `ack` is called
   * exactly once: ok once the session is bound, or a fixed refusal. */
  onDeskResume: (
    req: { conversationId: string },
    effects: () => Promise<{ fx: BotEffects }>,
    ack: (r: DeskAckResult) => void,
  ) => Promise<void>;
  /** The owner's desk Continue in Discord (#695): `openThread` opens a thread for `req` (no
   * fallback — a failure refuses `thread-failed` with nothing written) and returns its effects and
   * the owner's mention. The thread is catalogued as the configured owner's, a plain chat's tail is
   * saved once as a framed user-role turn (no memory capture), and a first post mentions the owner.
   * Agent mode (#696) moves an idle desktop CLI session in: a `delegate_runs` row for this surface
   * makes the thread its only owner, then it resumes restricted to the owner under a kept live card.
   * `ack` once: ok + threadId, `partial` + threadId when a step after the thread failed (the reason
   * is posted there; never a fresh session), or a refusal. */
  onDeskContinue: (
    req: DeskContinueBody,
    openThread: (ownerId: string) => Promise<{ threadId: string; fx: BotEffects; mention: string }>,
    ack: (r: DeskContinueResult) => void,
  ) => Promise<void>;
} {
  const chimeIn = deps.chatter && makeChimeIn({
    chatter: deps.chatter, chat: deps.chat, model: deps.model, rankByMeaning: deps.rankByMeaning,
    loadPersona: deps.loadPersona, loadMemories: deps.loadMemories, conversations: deps.conversations,
    liveSession: (conv) => deps.liveSessions.has(conv),
    onError: (err) => console.error(`[chatter] chime-in failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  const channelCapture = deps.chatter && makeAmbientCapture({
    chatter: deps.chatter, chat: deps.chat, model: deps.model, roleOf: (s) => deps.roles.roleOf(s),
    loadMemories: deps.loadMemories, appendMemories: deps.appendMemories, autoMemoryEnabled: deps.autoMemoryEnabled,
    onError: (err) => console.error(`[memory] channel capture failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  const noteTool = retrieveNoteTool(deps.searchNotes);

  // Away mode (#904): a non-bot sender other than the owner explicitly tags the owner while away
  // here → record the message (owner-only table), then one fixed, non-pinging line in the same
  // conversation (and maybe Bean's labelled suggestion after it). A redelivered message is already recorded and gets nothing; a storage failure
  // still gets the away line, minus the claim it was recorded. Never rejects.
  // Silent read-only prepares (#909): built only with an executor; a row a dead process left
  // running is marked interrupted here, then the persisted queue resumes.
  const awayPrepare = deps.away && deps.awayPrepareRun
    ? makeAwayPrepare({
        away: deps.away, run: deps.awayPrepareRun, loadProjects: deps.loadProjects,
        ...(deps.scratchPath ? { scratchPath: deps.scratchPath } : {}),
        detectClis: deps.detectClis, cliModels: deps.cliModels, loadModelMemory: deps.loadModelMemory,
      })
    : undefined;
  awayPrepare?.pump();

  async function awayTag(conversationId: string, line: AmbientLine, post: (text: string) => Promise<void>): Promise<void> {
    const away = deps.away;
    const configured = deps.roles.ownerId;
    if (!away || !configured || line.bot || !line.messageId || !line.taggedIds?.length) return;
    try {
      const state = away.get();
      if (!state.on || deps.roles.roleOf({ fromId: line.fromId, fromAltId: line.fromAltId }) === "owner") return;
      const owner = new Set(deps.catalog?.ownerIds(configured) ?? [configured]);
      if (!line.taggedIds.some((id) => owner.has(id))) return;
      let recorded = false;
      try {
        recorded = away.capture({
          conversationId, messageId: line.messageId, senderId: line.fromId, senderName: line.name,
          text: line.text, at: line.at, ...(line.link ? { link: line.link } : {}),
          ...(state.since !== undefined ? { awaySince: state.since } : {}),
        });
        if (!recorded) return;
      } catch (err) {
        console.error(`[away] capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await post(awayLine(deps.roles.ownerName, state.reason, recorded));
      // Then, under the daily cap, one suggestion call: with config `webSearch` on, Bean's own
      // labelled suggestion as a second message (#907); with a read-only CLI here, it may also
      // queue a silent prepare (#909) — the call runs for that even with webSearch off, its text
      // discarded. The line above never waits for it. A prepare needs this message's own row.
      const webSearch = !!deps.webSearchEnabled?.();
      const canPrepare = !!awayPrepare && recorded && deps.detectClis().some((c) => c === "claude" || c === "codex");
      if ((webSearch || canPrepare) && away.claimSuggestion()) {
        const projects = canPrepare ? (await deps.loadProjects()).map((p) => p.name) : undefined;
        const s = awaySuggestion({
          chat: deps.chat, model: deps.model, ownerName: deps.roles.ownerName, text: line.text, webSearch,
          ...(projects ? { projects } : {}),
        });
        const messageId = line.messageId;
        // Each result acts as soon as its call settles: a slow web search never holds the claim.
        await Promise.all([
          s.prepare.then((p) => {
            if (!p || !awayPrepare) return;
            try {
              const notPrepared = away.claimPrepare({
                conversationId, messageId, senderId: line.fromId, ...p,
                ...(state.since !== undefined ? { awaySince: state.since } : {}),
              });
              if (notPrepared === undefined) awayPrepare.pump();
            } catch (err) {
              console.error(`[away] prepare claim failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }),
          s.text.then(async (t) => { if (t) await post(t); }),
        ]);
      }
    } catch (err) {
      console.error(`[away] owner-tag reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // DM auto-capture (#462): after the reply, the latest typed turn's facts are saved private to
  // the speaker, each with the usual Forget/Share receipt. Captures run one at a time so each
  // sees what the last one saved; never rejects. ponytail: one chain for every DM; per-speaker
  // chains if capture latency ever queues up.
  let captureChain: Promise<void> = Promise.resolve();
  // `owner` = the owner's own DM: facts keep the model's English category (#648); a member's don't.
  // No `fx` = no receipt card (live steering, #861: a card would interrupt the agent's thread).
  function captureDm(
    speakerId: string, recall: string | string[], transcript: ChatTurn[], projects: Project[], fx: BotEffects | undefined, owner: boolean,
  ): Promise<void> {
    return captureChain = captureChain.then(async () => {
      if (!(await deps.autoMemoryEnabled?.())) return;
      const { candidates, rejected, failed } = await extractMemories(
        transcript, await deps.loadMemories(recall, { allSources: owner }), projects, { chat: deps.chat, model: deps.model }, { latestTurn: true, categorize: owner, member: !owner },
      );
      // Counts only — a rejected candidate's text may be exactly what validation refused to keep.
      if (rejected > 0) console.warn(`[memory] DM capture rejected ${rejected} candidate(s)`);
      if (failed) throw new Error("extraction model call failed");
      // Re-checked right before the insert: autoMemory switched off during the call wins.
      if (candidates.length === 0 || !(await deps.autoMemoryEnabled?.())) return;
      const at = new Date().toISOString();
      const batch: Memory[] = candidates.map((c) => ({
        id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: at, subjectId: speakerId,
        ...(owner && c.category ? { category: c.category } : {}),
        ...(c.kind ? { kind: c.kind } : {}), ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}), ...(c.evidence ? { evidence: c.evidence } : {}),
      }));
      await deps.appendMemories(batch);
      if (fx) for (const m of batch) {
        const projectName = m.projectPath ? projects.find((p) => p.path === m.projectPath)?.name : undefined;
        await fx.postCard(deps.cards.rememberedCard({ memoryId: m.id, text: m.text, projectName, category: m.category, scope: "private" }));
      }
    }).catch((err: unknown) => {
      console.error(`[memory] DM capture failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  // Each live session's last steer and last turn result (#857), in the order they happened, so a
  // steer that answers the agent's question is captured with that question as non-citable
  // context. Tagged with the session's run id: an earlier session's turns never reach a new one's.
  const liveTurns = new Map<string, { run: string; turns: ChatTurn[] }>();
  function noteLiveTurn(conv: string, run: string | undefined, turn: ChatTurn): void {
    if (!run) return;
    const prev = liveTurns.get(conv);
    const kept = prev?.run === run ? prev.turns.filter((t) => t.role !== turn.role) : [];
    liveTurns.set(conv, { run, turns: [...kept, turn] });
  }
  const liveContext = (conv: string): ChatTurn[] => {
    const e = liveTurns.get(conv);
    return e && e.run === deps.liveSessions.generation(conv) ? e.turns : [];
  };
  const systemTool = systemControlTool(deps.systemControlsEnabled);

  // Refusals sent once per key per process (DM gate per user, card taps per user per card), then
  // silent. ponytail: unbounded until restart, cleared wholesale at 1000 entries.
  const refusedOnce = new Set<string>();
  const firstRefusal = (key: string): boolean => {
    if (refusedOnce.has(key)) return false;
    if (refusedOnce.size >= 1000) refusedOnce.clear();
    refusedOnce.add(key);
    return true;
  };

  // `enabled: false` is the skill's off switch and it applies here too. `quick-launch: false`
  // deliberately does not — that one only trims the desktop avatar's drag bloom.
  const loadActiveSkills = async (): Promise<Skill[]> =>
    (await deps.loadSkills()).filter((s) => s.enabled !== false);

  // Run events fire from the delegate's stream callbacks, outside any awaited chain. A rejected
  // surface call (e.g. Discord 400 on an oversized card edit) left unhandled kills the bot
  // process and loses the run's result — log it and keep going. A failed card edit must not
  // block posting the result either, hence the inner catches.
  function logRunEffectError(err: unknown): void {
    console.error("chatops run effect failed:", err);
  }

  // Live-capable CLIs available right now, claude first (the default engine).
  const liveClis = (): LiveCli[] => {
    if (!deps.liveSessionsEnabled()) return [];
    const detected = deps.detectClis();
    return LIVE_CLIS.filter((c) => detected.includes(c));
  };
  // A finished/ended card's Continue live (#1002), or why there is none: only for the CLI that
  // ran it, while live sessions are on and that CLI is still here, with that CLI's id shape.
  const continueLive = (cli: CliName, sessionId: string | undefined): { resumeLiveId?: string; noContinue?: NoContinueReason } => {
    if (!sessionId) return {};
    if (!deps.liveSessionsEnabled()) return { noContinue: "disabled" };
    if (!isLiveCli(cli) || !isLiveSessionId(cli, sessionId)) return { noContinue: "surface" };
    if (!deps.detectClis().includes(cli)) return { noContinue: "cli-missing" };
    return { resumeLiveId: sessionId };
  };
  // The literal --model for a live session: kept only if that CLI's config offers it, else the
  // CLI's own default — a model from another provider never switches the engine.
  const liveModelFor = (cli: LiveCli, model: string | undefined): string | undefined =>
    model && cliOffersModel(deps.cliModels, cli, model) ? model : undefined;
  // The last started fresh live session's card picks, in model memory beside the delegate's
  // `teams:*` keys: a new card opens on them. "" = no skill / the CLI's default model.
  const LIVE_PROJECT = "live:project", LIVE_CLI = "live:cli", LIVE_SKILL = "live:skill";
  const liveModelKey = (cli: LiveCli): string => `live:model:${cli}`;

  // One conversation (#998): where a conversation's model history lives. Once the main log's
  // cutover marker exists, the owner's real 1:1 DM — its catalog row (written only for an owner's
  // direct message) whose owner is still the configured one (Teams aliases go through roleOf) —
  // maps to the main conversation; everything else, and everything before the marker, keeps its
  // own id. Fail closed: no mainLog, no catalog, no row, a changed owner → the real id. Only
  // history moves: cards, runs, reminders, live bindings and catalog rows keep the real DM id.
  const historyId = (conversationId: string): string => {
    if (!deps.mainLog?.cutover()) return conversationId;
    const row = deps.catalog?.get(conversationId);
    return row?.kind === "dm" && !row.archivedFrom &&
      deps.roles.roleOf({ fromId: row.ownerId, fromAltId: row.ownerAltId }) === "owner" ? MAIN_CONVERSATION_ID : conversationId;
  };
  const appendHistory = (conversationId: string, turn: ChatTurn, id = historyId(conversationId)): void => {
    deps.conversations.append(id, turn, id === MAIN_CONVERSATION_ID && deps.mainLog ? { surface: deps.mainLog.surface } : {});
  };

  // `/new` count per conversation (this process): a run launched before a reset must not
  // store its session afterwards and resurrect the pre-reset agent.
  const resets = new Map<string, number>();

  // Task grants (epic #1111, delegate-grant.ts): a confirmed delegate card's run lets the person who
  // confirmed it continue its agent session from this real conversation (never historyId()'s shared
  // `main`) without a new card. Memory only — a restart drops them (fail closed: cards again); `/new`
  // revokes. One surface per process, so the grant's surface tag only has to be consistent.
  const grantSurface = deps.mainLog?.surface ?? "discord";
  const grants = new Map<string, { grant: DelegateGrant; instruction: string }>();
  // Bean's turn on a delegate's end (#1133): each person's addressed turns per conversation (one
  // after the run ended drops its automatic follow-up — ambient chatter never reaches onMessage), and
  // the runs whose end was already answered (a completion delivered twice gets one turn). Memory only.
  // ponytail: `addressed` grows by conversation × speaker until restart.
  const addressed = new Map<string, number>();
  const spoke = (conv: string, id: string): number => addressed.get(`${conv}\n${id}`) ?? 0;
  const answeredRuns = new Set<string>();

  // The model's record of a confirm card (#941): one code-built assistant line after each card
  // post and at each authorized outcome — kind, state and a catalog name only (card-record.ts).
  // Appended before the card edit is awaited, so a quick follow-up already sees it.
  const recordCard = (conversationId: string, kind: CardRecordKind, state: CardRecordState, name?: string): void => {
    appendHistory(conversationId, { role: "assistant", content: cardRecord(kind, state, name) });
  };
  // A tap whose claim came back empty: `expired` only when the proposal was still held for this
  // conversation (peeked raw before the claim). A consumed, forged or other-conversation id
  // leaves no record.
  const recordExpired = (held: { conversationId: string } | undefined, conversationId: string, kind: CardRecordKind, name?: string): void => {
    if (held?.conversationId === conversationId) recordCard(conversationId, kind, "expired", name);
  };

  /** `confirmed`: the tap that confirmed the card — its platform identity (never the display name),
   * whom a run that reports its session grants cardless follow-ups, and the conversation's `/new`
   * count when it arrived (a `/new` after it means no grant and no thread pointer). `continued`: a
   * cardless continuation of that grant — resumes its session strictly and posts the compact card itself. */
  async function startRun(
    p: Pick<PendingProposal, "proposal" | "conversationId" | "cardActivityId" | "fresh">, cli: CliName, model: string | undefined,
    startedBy: string, fx: BotEffects, confirmed?: { actorId: string; resets: number },
    continued?: {
      grant: DelegateGrant; recheck: () => string | undefined;
      /** Bean's own follow-up (#1133): its number; never renews the idle clock; `refused` replaces
       * the default notice when the recheck stops it. */
      followUp?: number; refused?: (why: string) => Promise<void>;
    },
    actor?: RunActor,
  ): Promise<void> {
    // Before any await: a `/new` from here on must not let this run store a session or grant.
    const resetsAtLaunch = confirmed?.resets ?? resets.get(p.conversationId) ?? 0;
    const actorId = confirmed?.actorId;
    const projects = await deps.loadProjects();
    // Shared channel: an unregistered project shows its folder name, never the absolute path.
    const projectName = delegateProjectLabel(p.proposal.projectPath, projects);
    // Recomposed here, not taken from proposal.composedPrompt: the card's skill picker can
    // swap the skill after converse() composed it, so the body must be re-applied at launch.
    const skill = p.proposal.skillName
      ? (await deps.loadSkills()).find((s) => s.name === p.proposal.skillName)
      : undefined;
    // A named skill that no longer resolves (deleted/renamed while the card sat, or a bogus
    // submitted value) must not silently degrade into a bare-instruction run: the card said
    // one thing, the run would do another. Refuse instead.
    if (p.proposal.skillName && !skill) {
      recordCard(p.conversationId, "delegate", "didn't start"); // never the unresolved picked name
      if (p.cardActivityId !== undefined) {
        await fx.updateCard(p.cardActivityId, deps.cards.finishedCard({
          projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled", agent: cli,
        }));
      }
      await fx.post(`I can't find the \`${p.proposal.skillName}\` skill any more — ask me again and pick a skill that still exists.`);
      return;
    }
    // Thread sessions: continue this thread's earlier agent for the same CLI; another CLI
    // starts fresh, as does a session from another project (RunRegistry.start; see
    // .memory/project-thread-sessions.md).
    // The main conversation (#998) never resumes from a card: every owner-DM card starts fresh. Its
    // resumes are the task grant's cardless continuation (strict: refused, never fresh) and the
    // finished card's Continue live. A fallback card (a continuation that didn't match) starts fresh.
    const onMain = historyId(p.conversationId) === MAIN_CONVERSATION_ID;
    const resume = continued ? continued.grant.sessionId
      : onMain || p.fresh ? undefined : deps.conversations.threadSession(p.conversationId, cli);
    const wire = resolveWireModel(deps.cliModels, cli, model);
    const req: DelegateRequest = {
      cli,
      projectPath: p.proposal.projectPath,
      // A continuation sends what converse() composed (the skill body only if the model named it
      // again): the resumed agent already has the task's skill in its context.
      prompt: continued ? p.proposal.composedPrompt
        : skill ? composePrompt(skill, p.proposal.instruction) : p.proposal.instruction,
      ...(wire.model !== undefined ? { model: wire.model } : {}),
      ...(wire.effort !== undefined ? { effort: wire.effort } : {}),
      ...(resume ? { resume } : {}),
      ...(continued ? { strictResume: true } : {}),
      ...(skill?.browser ? { browser: true } : {}),
    };
    // Every settle: a confirmed run with a session grants its confirmer the task (replacing an older
    // grant) unless `/new` ran since launch; a continuation restarts its grant's idle clock, or ends
    // the grant when it didn't resume that session. A late settle never touches a newer or revoked grant.
    const settleGrant = (sessionId: string | undefined): void => {
      const conv = p.conversationId;
      const held = grants.get(conv);
      if (continued) {
        if (!held || held.grant.revoked || held.grant.generation !== continued.grant.generation) return;
        const grant = sessionId !== continued.grant.sessionId ? revokeGrant(held.grant)
          : continued.followUp ? held.grant : refreshGrant(held.grant, Date.now());
        grants.set(conv, { ...held, grant });
        return;
      }
      if (!sessionId || actorId === undefined || (resets.get(conv) ?? 0) !== resetsAtLaunch) return;
      grants.set(conv, {
        grant: createGrant({
          surface: grantSurface, scopeKey: conv, actorId, projectPath: p.proposal.projectPath, cli,
          ...(model !== undefined ? { model } : {}), ...(p.proposal.skillName ? { skillName: p.proposal.skillName } : {}),
          browser: skill?.browser === true, sessionId,
        }, Date.now(), held?.grant),
        instruction: p.proposal.instruction,
      });
    };
    const receipt = (sessionId: string | undefined, last: string | undefined) => {
      const line = lastSaidLine(last);
      return {
        agent: cli,
        ...(line ? { lastLine: line } : {}),
        ...(sessionId ? { resume: resumeCommand(cli, sessionId) } : {}),
        ...continueLive(cli, sessionId),
      };
    };
    // Read late: a continuation posts its own card just below.
    const updateTo = async (card: object): Promise<void> => {
      if (p.cardActivityId !== undefined) await fx.updateCard(p.cardActivityId, card);
    };
    let runId = "";
    const running = (tail?: string): object => deps.cards.runningCard({
      projectName, instruction: p.proposal.instruction, startedBy, runId, ...(tail !== undefined ? { tail } : {}),
      ...(continued ? { continued: true as const } : {}), ...(continued?.followUp ? { followUp: continued.followUp } : {}),
    });
    let ended = false; // a launch that fails synchronously ends before start() returns
    if (continued) {
      // No proposal card to edit: the compact card (no Cancel until the run has an id) is posted first.
      // Bean's follow-up edits the run's own card in place.
      if (p.cardActivityId === undefined) p.cardActivityId = await fx.postCard(running());
      // Checked again after the turn's last await, right before dispatch: a `/new`, a role change or a
      // skill that gained `browser: true` (the request's own `skill`) meanwhile refuses — never runs.
      const why = continued.recheck() ?? (skill?.browser && !continued.grant.browser ? GRANT_MISMATCH_TEXT.browser : undefined);
      if (why) {
        recordCard(p.conversationId, "delegate", "didn't start");
        if (continued.refused) return continued.refused(why);
        await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled", agent: cli }));
        await fx.post(`${why} Nothing ran — ask me again.`);
        return;
      }
    }
    // The run's end, answered once (#1133): Bean's turn for the person it answers to — taken at the
    // end, synchronously: the grant it settled on and how often they had spoken here — else the
    // run's own words (`raw`: a failure keeps the agent's report of what it did finish).
    // Not `runId`: a launch that fails synchronously ends before it has one.
    const endKey = randomUUID();
    const answerFor = (sessionId: string | undefined, outcome: Exclude<DelegateOutcome, { type: "cancelled" }>): (() => Promise<void>) => {
      const conv = p.conversationId;
      const failure = outcome.type === "failed" ? outcome.message : undefined;
      const final = outcome.type === "failed" ? trimDelegateFinal(outcome.final) : undefined;
      const raw = outcome.type === "done" ? outcome.result : `Delegate run failed: ${outcome.message}${final ? `\n\n${final}` : ""}`;
      const g = grants.get(conv)?.grant;
      const generation = actor && sessionId && g && !g.revoked && g.sessionId === sessionId && g.actorId === actor.id ? g.generation : undefined;
      const spokeAtEnd = actor ? spoke(conv, actor.id) : 0;
      // This run's own outcome turn, not just "the latest record": two runs ending together each judge theirs.
      const turn = delegateOutcomeTurn(p.proposal.instruction, outcome);
      return () => actor
        ? outcomeTurn({
            endKey, conv, actor, fx, raw, turn, spokeAtEnd, card: p.cardActivityId,
            ...(generation !== undefined ? { generation } : {}), ...(failure !== undefined ? { failure } : {}),
          })
        : (fx.postResult ?? fx.post)(raw);
    };
    const started = await deps.runs.start(
      req,
      {
        onTail: (line) => {
          updateTo(running(line)).catch(logRunEffectError);
        },
        onDone: (result, sessionId) => {
          ended = true;
          if (sessionId && !onMain && (resets.get(p.conversationId) ?? 0) === resetsAtLaunch) {
            deps.conversations.setThreadSession(p.conversationId, cli, sessionId);
          }
          settleGrant(sessionId);
          const answer = answerFor(sessionId, { type: "done", result });
          void (async () => {
            appendHistory(p.conversationId, { role: "assistant", content: delegateOutcomeRecord(p.proposal.instruction, { type: "done", result }) });
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "done", ...receipt(sessionId, result) })).catch(logRunEffectError);
            await answer();
          })().catch(logRunEffectError);
        },
        onError: (message, sessionId, last) => {
          ended = true;
          settleGrant(sessionId);
          const answer = answerFor(sessionId, { type: "failed", message, ...(last !== undefined ? { final: last } : {}) });
          void (async () => {
            recordCard(p.conversationId, "delegate", "failed", p.proposal.skillName);
            appendHistory(p.conversationId, { role: "assistant", content: delegateOutcomeRecord(p.proposal.instruction, { type: "failed", message, final: last }) });
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "error", ...receipt(sessionId, last) })).catch(logRunEffectError);
            await answer();
          })().catch(logRunEffectError);
        },
        onCancelled: (sessionId, last) => {
          ended = true;
          settleGrant(sessionId);
          void (async () => {
            recordCard(p.conversationId, "delegate", "cancelled", p.proposal.skillName);
            appendHistory(p.conversationId, { role: "assistant", content: delegateOutcomeRecord(p.proposal.instruction, { type: "cancelled", final: last }) });
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled", ...receipt(sessionId, last) })).catch(logRunEffectError);
            await fx.post("Run cancelled.");
          })().catch(logRunEffectError);
        },
      },
      { instruction: p.proposal.instruction, conversationId: p.conversationId },
    );
    runId = started;
    if (!ended) {
      recordCard(p.conversationId, "delegate", "running", p.proposal.skillName);
      await updateTo(running());
    }
    const memory = await deps.loadModelMemory();
    await deps.saveModelMemory({ ...memory, ...memoryUpdatesFor({ cli, model }) });
  }

  /** A `continue` proposal from `msg`'s speaker: started on the grant offered with the turn when it
   * still matches (actor, project, CLI, model, skill, no added browser), the CLI is still here and
   * nothing holds the session. Resolves undefined once started, else the fallback card's reason. */
  async function continueTask(
    msg: IncomingMessage, plain: ProposedDelegate, offered: DelegateGrant, detected: CliName[], skills: Skill[], fx: BotEffects,
  ): Promise<string | undefined> {
    const conv = msg.conversationId;
    const held = grants.get(conv);
    const skillName = plain.skillName ?? held?.grant.skillName;
    const browser = skillName !== undefined && skills.find((s) => s.name === skillName)?.browser === true;
    const m = matchGrant(held?.grant, {
      surface: grantSurface, scopeKey: conv, actorId: msg.fromId, projectPath: plain.projectPath,
      ...(plain.cli ? { cli: plain.cli } : {}), ...(plain.model ? { model: plain.model } : {}),
      ...(plain.skillName ? { skillName: plain.skillName } : {}), ...(browser ? { browser } : {}),
      generation: offered.generation,
    }, Date.now());
    if (!m.ok) return GRANT_MISMATCH_TEXT[m.reason];
    const g = m.grant;
    if (!detected.includes(g.cli)) return GRANT_MISMATCH_TEXT.cli;
    // Two writers never drive one session: a run still on it, or a live session bound here.
    if (deps.runs.busy(conv, g.cli) || deps.liveSessions.has(conv)) return GRANT_MISMATCH_TEXT.busy;
    grants.set(conv, { grant: refreshGrant(g, Date.now()), instruction: plain.instruction });
    const proposal: ProposedDelegate = {
      ...plain, projectPath: g.projectPath, cli: g.cli,
      ...(g.model !== undefined ? { model: g.model } : {}), ...(g.skillName !== undefined ? { skillName: g.skillName } : {}),
    };
    // The speaker's role and the grant as they are at dispatch, not as the turn found them.
    const recheck = (): string | undefined => {
      const { role, scopeId } = speakerRole(msg);
      if (!can(role, "delegate")) return refusal(needs("delegate"), role, "run tasks", deps.roles, scopeId);
      if (deps.liveSessions.has(conv)) return GRANT_MISMATCH_TEXT.busy; // bound while the card posted
      const now = matchGrant(grants.get(conv)?.grant, { surface: grantSurface, scopeKey: conv, actorId: msg.fromId, generation: g.generation }, Date.now());
      return now.ok ? undefined : GRANT_MISMATCH_TEXT[now.reason];
    };
    await startRun({ proposal, conversationId: conv }, g.cli, g.model, msg.fromName, fx, undefined, { grant: g, recheck }, {
      id: msg.fromId, ...(msg.fromAltId ? { altId: msg.fromAltId } : {}),
      ...(msg.direct || !msg.scopeId ? {} : { scopeId: msg.scopeId }), name: msg.fromName,
    });
    return undefined;
  }

  /** Bean's turn on a delegate's end (#1133), for `o.actor` (who confirmed or continued the run).
   * Bean judges the run's own `delegateOutcomeTurn` (`o.turn`) and answers with one message in place of the
   * run's raw words (`o.raw` stays the fallback: the daily cap, a failed model call, no reply). While
   * the grant the run settled on holds (`o.generation`) and its follow-up budget lasts, Bean may
   * continue the same session once more: the run's card turns running again in place and this reply
   * waits in history for that run's end. A follow-up that doesn't run ends this message with why. */
  async function outcomeTurn(o: {
    /** One per run (its end may be delivered twice): the execution dedupe and the cap's turn id. */
    endKey: string; conv: string; actor: RunActor; fx: BotEffects; raw: string; turn: string; spokeAtEnd: number;
    card?: string; generation?: number; failure?: string;
  }): Promise<void> {
    const { conv, actor, fx } = o;
    if (answeredRuns.has(o.endKey)) return;
    if (answeredRuns.size >= 1000) answeredRuns.clear();
    answeredRuns.add(o.endKey);
    const post = (text: string): Promise<void> => (fx.postResult ?? fx.post)(text);
    const role = deps.roles.roleOf({ fromId: actor.id, fromAltId: actor.altId, scopeId: actor.scopeId });
    // Stable per completion, so a redelivery is never counted twice (the cap admits a known id again).
    if (role !== "owner" && deps.turnCap && !deps.turnCap.admit({ turnId: `delegate-outcome:${o.endKey}`, userId: actor.id, userName: actor.name })) {
      return post(`${o.raw}\n\n${FOLLOW_UP_CAPPED}`);
    }
    const hid = historyId(conv);
    const held = grants.get(conv);
    const m = o.generation !== undefined && can(role, "delegate")
      ? matchFollowUp(held?.grant, { surface: grantSurface, scopeKey: conv, actorId: actor.id, generation: o.generation }, o.failure, Date.now())
      : undefined;
    const offered = m?.ok ? held : undefined;
    const note = m === undefined ? undefined : m.ok ? followUpNote((m.grant.followUps ?? 0) + 1) : followUpRefusedNote(m.reason);
    let result: ConverseResult;
    let skills: Skill[] = [];
    try {
      const [loaded, projects, persona] = await Promise.all([offered ? loadActiveSkills() : [], deps.loadProjects(), deps.loadPersona()]);
      skills = loaded;
      const detected = deps.detectClis();
      result = await converse({
        skills, projects, persona, memories: [],
        deps: { chat: deps.chat, model: deps.model, rankByMeaning: deps.rankByMeaning },
        history: hid === MAIN_CONVERSATION_ID ? await boundMainLog(deps.conversations, { chat: deps.chat, model: deps.model }) : deps.conversations.history(hid),
        latestUserText: o.turn,
        delegateAvailable: offered !== undefined, ...(offered ? { scratchPath: deps.scratchPath } : {}), availableClis: detected, models: availableModels(deps.cliModels, detected),
        runAvailable: false, noteAvailable: false, skillAuthoringAvailable: false, liveSessionAvailable: false,
        roleNote: [roleLine(role, deps.roles, actor.scopeId), note].filter(Boolean).join("\n\n"),
        ...(offered ? { activeSession: {
          cli: offered.grant.cli, projectPath: offered.grant.projectPath, lastInstruction: offered.instruction,
          projectName: delegateProjectLabel(offered.grant.projectPath, projects),
        } } : {}),
      });
    } catch (err) {
      console.error(`[chatops] delegate outcome turn failed: ${err instanceof Error ? err.message : String(err)}`);
      return post(o.raw);
    }
    const cont = offered && result.proposedDelegate?.continue ? result.proposedDelegate : undefined;
    const reply = result.error !== undefined || (!cont && result.reply === CARD_LEAD) ? "" : result.reply.trim();
    if (!reply) return post(o.raw);
    appendHistory(conv, { role: "assistant", content: reply }, hid);
    if (!cont) return post(reply);
    const skipped = (why: string): Promise<void> => post(`${reply}\n\n${why}`);
    // Re-checked here and again right before dispatch (startRun's recheck): the person spoke since
    // the run ended, their role, the grant (generation, revocation, budget, same failure), the task's
    // skill gaining `browser`, a live session bound here, the CLI still installed.
    const recheck = (): string | undefined => {
      if (spoke(conv, actor.id) !== o.spokeAtEnd) return FOLLOW_UP_REPLIED;
      const now = deps.roles.roleOf({ fromId: actor.id, fromAltId: actor.altId, scopeId: actor.scopeId });
      if (!can(now, "delegate")) return refusal(needs("delegate"), now, "run tasks", deps.roles, actor.scopeId);
      if (deps.liveSessions.has(conv)) return followUpRefusedText("busy");
      return undefined;
    };
    const early = recheck();
    if (early) return skipped(early);
    const { continue: _c, ...plain } = cont;
    const skillName = plain.skillName ?? held?.grant.skillName;
    const browser = skillName !== undefined && skills.find((s) => s.name === skillName)?.browser === true;
    const fm = matchFollowUp(grants.get(conv)?.grant, {
      surface: grantSurface, scopeKey: conv, actorId: actor.id, projectPath: plain.projectPath,
      ...(plain.cli ? { cli: plain.cli } : {}), ...(plain.model ? { model: plain.model } : {}),
      ...(plain.skillName ? { skillName: plain.skillName } : {}), ...(browser ? { browser } : {}),
      generation: o.generation!,
    }, o.failure, Date.now());
    if (!fm.ok) return skipped(followUpRefusedText(fm.reason));
    const g = fm.grant;
    if (!deps.detectClis().includes(g.cli)) return skipped(followUpRefusedText("cli"));
    if (deps.runs.busy(conv, g.cli)) return skipped(followUpRefusedText("busy"));
    // Spends the budget before the run starts: a stopped or refused follow-up still counts.
    const next = reserveFollowUp(g, o.failure);
    grants.set(conv, { grant: next, instruction: plain.instruction });
    const proposal: ProposedDelegate = {
      ...plain, projectPath: g.projectPath, cli: g.cli,
      ...(g.model !== undefined ? { model: g.model } : {}), ...(g.skillName !== undefined ? { skillName: g.skillName } : {}),
    };
    const dispatchCheck = (): string | undefined => {
      const why = recheck();
      if (why) return why;
      const live = matchGrant(grants.get(conv)?.grant, { surface: grantSurface, scopeKey: conv, actorId: actor.id, generation: g.generation }, Date.now());
      return live.ok ? undefined : followUpRefusedText(live.reason);
    };
    await startRun(
      { proposal, conversationId: conv, ...(o.card !== undefined ? { cardActivityId: o.card } : {}) }, g.cli, g.model, actor.name, fx, undefined,
      { grant: next, recheck: dispatchCheck, followUp: next.followUps ?? 1, refused: skipped }, actor,
    );
  }

  // A picked skill must still exist and be enabled (never a silent bare-instruction start), and a
  // browser skill can't run on opencode.
  async function liveSkill(cli: LiveCli, skillName: string | undefined): Promise<{ skill?: Skill; refusal?: string }> {
    if (!skillName) return {};
    const skill = (await loadActiveSkills()).find((s) => s.name === skillName);
    if (!skill) return { refusal: `I can't find the \`${skillName}\` skill any more — pick one that still exists.` };
    if (skill.browser && cli === "opencode") return { refusal: OPENCODE_BROWSER_REFUSAL };
    return { skill };
  }

  // The live card's effective CLI and skill once a submit's selections (Teams merges them into
  // Start; Discord applied them already, so its value omits them) land on the proposal. A resume
  // keeps the CLI frozen from its row.
  const liveCliOf = (p: ProposedLiveSession, v: CardAction["value"]): LiveCli =>
    p.resume?.cli ?? (isLiveCli(v.cli) ? v.cli : p.cli) ?? liveClis()[0] ?? "claude";
  const liveSkillNameOf = (p: ProposedLiveSession, v: CardAction["value"]): string | undefined =>
    v.skillName === undefined ? p.skillName : v.skillName === "__none__" ? undefined : v.skillName || undefined;

  // The result card replaces the proposal card that showed the prompt: a fresh session's carries it on.
  const shownPrompt = (p: ProposedLiveSession): { prompt?: string } => (p.resume || !p.instruction ? {} : { prompt: p.instruction });

  /** `owner` set = the owner tapped Start (or Continue live at the desk): the conversation goes
   * into the catalog with this session's live binding. `quiet` = a desk resume: a refusal is only
   * returned (the desk shows its own line), never posted to the channel. */
  async function startLiveSessionAction(
    p: PendingLiveSession, startedBy: string, starterId: string, fx: BotEffects,
    owner?: { altId?: string; place: ConversationPlace }, quiet = false,
  ): Promise<DeskAckResult> {
    const updateTo = async (card: object): Promise<void> => {
      if (p.cardActivityId !== undefined) await fx.updateCard(p.cardActivityId, card);
    };
    const resume = p.proposal.resume;
    // A resume runs on the CLI frozen from its row; another installed CLI never substitutes.
    const cli = resume?.cli ?? p.proposal.cli ?? liveClis()[0] ?? "claude";
    let refusal = resume ? resumeRefusal(resume, starterId) : undefined;
    refusal ??= liveClis().includes(cli) ? undefined : { refused: "cli-missing", text: `${cli} isn't installed on this Mac any more.` };
    // A resume has no opening turn for a skill to frame.
    const picked = refusal || resume ? {} : await liveSkill(cli, p.proposal.skillName);
    if (picked.refusal) refusal = { refused: "no-record", text: picked.refusal };
    // The claimed proposal is frozen, so this is the race-free registry check (Start's pre-claim
    // check can go stale while the card sits). A resume keeps its recorded, maybe unregistered, folder.
    if (!refusal && !resume && !(await registeredProject(p.proposal.projectPath))) {
      refusal = { refused: "no-record", text: "That project isn't registered any more — this session wasn't started." };
    }
    // A desk move/resume ("desk") had no offer card, so it leaves no card record.
    const fromCard = p.id !== "desk";
    if (refusal) {
      if (fromCard) recordCard(p.conversationId, "live session", "didn't start");
      await updateTo(deps.cards.liveSessionResultCard({ projectName: await projectLabel(resume?.projectPath ?? p.proposal.projectPath, !!resume), startedBy, outcome: "cancelled", ...shownPrompt(p.proposal) }));
      if (!quiet) await fx.post(refusal.text);
      return { refused: refusal.refused };
    }
    if (resume) p.proposal.projectPath = resume.projectPath;
    const projectName = await projectLabel(p.proposal.projectPath, !!resume);
    // Plain-text stream messages: prefer the surface's real text path (postStream/editStream);
    // fall back to the card channel where {content} already IS a plain message (Discord).
    const sink: LiveSessionSink = {
      post: fx.postStream ?? ((text) => fx.postCard({ content: text })),
      edit: fx.editStream ?? ((id, text) => fx.updateCard(id, { content: text })),
      typing: fx.sendTyping,
    };
    // A picked skill's body frames the opening turn (composePrompt = body + "## Task" + text). A
    // resume has none: the channel's first message opens it, so no turn is spent until then.
    const instruction = resume ? "" : picked.skill ? composePrompt(picked.skill, p.proposal.instruction) : p.proposal.instruction;
    const conv = p.conversationId;
    // Before start(): the CLI's session id lands on this row. A resume binds its known id now (the
    // registry reports no id for it); a fresh session stays unbound until its id is recorded.
    if (owner && !deps.liveSessions.has(conv)) {
      deps.catalog?.upsert({
        conversationId: conv, place: owner.place, ownerId: starterId, ownerAltId: owner.altId,
        live: { cli, ...(resume ? { sessionId: resume.sessionId } : {}) },
      });
    }
    const resetsAtLaunch = resets.get(conv) ?? 0;
    let run: string | undefined; // set right after start(); turn results only arrive later
    // For the ended card (#1002): the session to continue (a fresh one's arrives via onSessionId,
    // once its delegate_runs row is written), this session's turns and the last thing the agent
    // said — streamed text too, so a turn stopped mid-way still shows where it stopped.
    let sessionId = resume?.sessionId;
    let turns = 0;
    let lastSaid: string | undefined;
    const liveWire = resolveWireModel(deps.cliModels, cli, liveModelFor(cli, p.proposal.model));
    const started = deps.liveSessions.start({
      channelId: p.conversationId,
      projectPath: p.proposal.projectPath,
      instruction,
      ask: p.proposal.instruction,
      cli,
      ...(liveWire.model ? { model: liveWire.model } : {}),
      ...(liveWire.effort ? { effort: liveWire.effort } : {}),
      ...(resume ? { resume: resume.sessionId } : {}),
      starterId,
      // Default restricted: only the starter (+ any co-drivers they add) steers, unless they
      // flipped the card to war-room.
      steering: p.proposal.steering ?? "restricted",
      sink,
      onTurnResult: (result) => {
        turns++;
        lastSaid = result;
        appendHistory(p.conversationId, { role: "assistant", content: `[live session] ${result}` });
        // ponytail: the last 2000 chars — where an agent's closing question sits.
        noteLiveTurn(conv, run, { role: "assistant", content: result.slice(-2000) });
      },
      onAgentText: (text) => {
        lastSaid = text;
      },
      onSessionId: (id: string) => {
        sessionId = id;
        // A `/new` since launch unbound the conversation; a late id must not bind it again.
        if (owner && (resets.get(conv) ?? 0) === resetsAtLaunch) deps.catalog?.setLiveSession(conv, cli, id);
      },
      onEnded: (notice) => {
        if (run && liveTurns.get(conv)?.run === run) liveTurns.delete(conv);
        updateToEnded().catch(logRunEffectError);
        fx.post(notice).catch(logRunEffectError);
      },
    });
    async function updateToEnded(): Promise<void> {
      // The session id doesn't change across a resume, so the ended card can offer it again; a
      // resume's card says what it continued.
      const prompt = resume ? resume.instruction : p.proposal.instruction;
      const line = lastSaidLine(lastSaid);
      await updateTo(deps.cards.liveSessionResultCard({
        projectName, startedBy, outcome: "ended", agent: cli, turns,
        ...(prompt ? { prompt } : {}), ...(line ? { lastLine: line } : {}), ...continueLive(cli, sessionId),
      }));
    }
    run = deps.liveSessions.generation(conv);
    if (started === "channel") {
      if (fromCard) recordCard(conv, "live session", "didn't start");
      if (!quiet) await fx.post("A live session is already running in this channel — say `stop` to end it first.");
      return { refused: "channel-busy" };
    }
    // The opening prompt is a turn like any steering message (steerLive): saved before its answer,
    // or history (and the desktop's synced view) holds the agent's reply to nothing.
    if (fromCard) recordCard(conv, "live session", "started");
    if (!resume && p.proposal.instruction) {
      appendHistory(conv, { role: "user", content: speakerLine(startedBy, p.proposal.instruction) });
    }
    await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "started", ...shownPrompt(p.proposal) }));
    // A resume's project and CLI were locked to its row, not picked — nothing to remember.
    if (!resume) {
      const memory = await deps.loadModelMemory();
      await deps.saveModelMemory({
        ...memory,
        [LIVE_PROJECT]: p.proposal.projectPath, [LIVE_CLI]: cli,
        [liveModelKey(cli)]: liveModelFor(cli, p.proposal.model) ?? "", [LIVE_SKILL]: picked.skill?.name ?? "",
      });
    }
    const mode = p.proposal.steering ?? "restricted";
    const ready = resume ? " It picks up where it left off on your next message." : "";
    await fx.post(mode === "open"
      ? `War-room mode: anyone here can steer. Say \`stop\` to end it.${ready}`
      : `Restricted mode: only you steer. Add co-drivers with \`+driver @name\`, remove with \`-driver @name\`. Say \`stop\` to end it.${ready}`);
    return { ok: true };
  }

  // A live card's project is client-influenced (Teams' Start submit, Discord's select): only an
  // exact registry match may become the cwd. No `__none__`/scratch here, unlike the delegate card.
  async function registeredProject(path: string): Promise<string | undefined> {
    return path ? (await deps.loadProjects()).find((pr) => pr.path === path)?.path : undefined;
  }

  // Shared by Start and the desk's Continue live. Re-checked at the launch point (the row or
  // folder may have gone while the card sat); the launch is always in the recorded folder — never
  // a path that arrived with the submit.
  function resumeRefusal(
    resume: NonNullable<ProposedLiveSession["resume"]>, starterId: string,
  ): { refused: DeskRefusal; text: string } | undefined {
    const found = deps.findDelegateRun?.(resume.sessionId) ?? { refusal: NO_RUN_RECORD };
    if ("refusal" in found) return { refused: "no-record", text: found.refusal };
    if (found.run.projectPath !== resume.projectPath || found.run.cli !== resume.cli) return { refused: "no-record", text: NO_RUN_RECORD };
    // Restricted needs an owner to gate on; the registry would otherwise open it to everyone.
    if (!starterId) return { refused: "not-eligible", text: "I couldn't tell who tapped Start, so I won't continue that session." };
    return undefined;
  }

  // Post the confirm-first Start/Cancel card. Shared by the LLM path (propose_live_session)
  // and the explicit /live-session command — both just fill in a ProposedLiveSession.
  async function postLiveSessionProposal(
    live: ProposedLiveSession, conversationId: string, proposedBy: string, fx: BotEffects, rememberProject = false,
  ): Promise<void> {
    const [projects, skills, memory] = await Promise.all([deps.loadProjects(), loadActiveSkills(), deps.loadModelMemory()]);
    const clis = liveClis();
    // A fresh card's unstated picks fall back to the last started session's, while they still
    // exist; a resume is locked to its row. `rememberProject` = the caller had no project in mind.
    const last = (key: string): string | undefined => (live.resume ? undefined : memory[key]);
    const lastCli = last(LIVE_CLI);
    // Frozen on a resume; a fresh card defaults to the last CLI, else claude when it's here.
    const cli = live.resume?.cli ?? [live.cli, lastCli].find((c): c is LiveCli => isLiveCli(c) && clis.includes(c)) ?? clis[0] ?? "claude";
    const lastProject = rememberProject ? projects.find((pr) => pr.path === last(LIVE_PROJECT))?.path : undefined;
    const lastSkill = skills.find((s) => !s.hidden && s.name === last(LIVE_SKILL))?.name;
    const proposal: ProposedLiveSession = {
      ...live,
      ...(lastProject ? { projectPath: lastProject } : {}),
      model: liveModelFor(cli, live.model ?? last(liveModelKey(cli))),
      ...(live.resume ? {} : { cli, skillName: live.skillName ?? lastSkill }),
    };
    const projectName = await projectLabel(proposal.projectPath, !!live.resume);
    const pending = deps.liveSessionProposals.add({ proposal, conversationId, proposedBy });
    const activityId = await fx.postCard(deps.cards.liveSessionProposalCard({
      proposalId: pending.id, projectName, instruction: proposal.instruction, model: proposal.model, skillName: proposal.skillName,
      projects: projects.map((p) => ({ name: p.name, path: p.path })),
      // Every live CLI's models, tagged; the card shows those of the selected CLI (Discord) or
      // all of them (Teams, resolved within the CLI at Start).
      models: availableModels(deps.cliModels, live.resume ? [cli] : clis),
      skills: skills.filter((s) => !s.hidden).map((s) => ({ name: s.name })),
      cli,
      ...(live.resume ? { clis: [], continues: live.resume.instruction, agent: cli } : { clis }),
    }));
    deps.liveSessionProposals.setCardActivityId(pending.id, activityId);
    recordCard(conversationId, "live session", "pending");
  }

  // Display name for a delegate's project. Shared channel: the scratch workspace and an
  // unregistered folder never show their absolute path.
  function delegateProjectLabel(path: string, projects: Project[]): string {
    return projects.find((pr) => pr.path === path)?.name
      ?? (path === deps.scratchPath ? "No project (scratch)" : basename(path) || "project");
  }

  // Display name for a project path. A resumed session's folder may be unregistered and the card
  // goes to a shared channel, so it falls back to the folder name, never the path.
  async function projectLabel(path: string, hidePath = false): Promise<string> {
    const name = (await deps.loadProjects()).find((p) => p.path === path)?.name;
    return name ?? (hidePath ? basename(path) || "project" : path);
  }

  // Continue live (finished-card button, or `/live-session resume <id>`): post the live confirm
  // card locked to the recorded run. Returns the refusal, or undefined once the card is posted.
  async function proposeResumeLive(conversationId: string, sessionId: string, proposedBy: string, fx: BotEffects): Promise<string | undefined> {
    if (!deps.liveSessionsEnabled()) return "Live sessions are disabled here.";
    const found = deps.findDelegateRun?.(sessionId) ?? { refusal: NO_RUN_RECORD };
    if ("refusal" in found) return found.refusal;
    const { run } = found;
    if (!liveClis().includes(run.cli)) return `${run.cli} isn't installed on this Mac any more.`;
    await fx.post(CARD_LEAD); // no converse() in this path, so no sentence of the model's (#978)
    await postLiveSessionProposal({
      // No opening turn: the session opens on the channel's first message.
      projectPath: run.projectPath, instruction: "", steering: "restricted",
      resume: { sessionId: run.sessionId, projectPath: run.projectPath, instruction: run.instruction, cli: run.cli },
    }, conversationId, proposedBy, fx);
    return undefined;
  }

  // Desk-continue agent mode (#696), once the thread is open: hand the desktop session to this
  // surface, bind it to the thread, and resume it restricted to the owner under a kept live card
  // (its idle end offers Continue live). A failure from here posts its reason in the thread and is
  // `partial` — never a fresh session; once moved, recovery is the thread's Continue live.
  async function moveDeskSession(
    catalog: ConversationCatalog, run: DelegateRunRow & { cli: LiveCli },
    t: { threadId: string; title: string; ownerId: string; fx: BotEffects; mention: string },
  ): Promise<DeskContinueResult> {
    const { threadId, ownerId, fx } = t;
    const place: ConversationPlace = { kind: "thread", title: t.title };
    const partial = async (reason: string, err?: unknown): Promise<DeskContinueResult> => {
      if (err !== undefined) console.warn("bean: desk continue step failed:", err instanceof Error ? err.name : "error");
      await fx.post(reason).catch(logRunEffectError);
      return { partial: true, threadId };
    };
    const stays = "I couldn't move that session here — it stays in Bean's desktop chat.";
    try {
      catalog.upsert({ conversationId: threadId, place, ownerId });
      await fx.post(`${t.mention} Continued from Bean desktop · moving the ${run.cli} session here`);
    } catch (err) {
      return partial(stays, err);
    }
    // One owner at a time: this surface's row becomes the session's newest, so the desktop's
    // lookup refuses it and a plain (chatops) lookup resolves it here. The desktop check is redone
    // right before the write with no await between, so a concurrent move of the same session
    // (which promoted it while this one awaited its thread) is refused, never started twice.
    const still = deps.findDelegateRun?.(run.sessionId, "desktop");
    const moved = !!still && "run" in still && deps.recordDelegateRun?.({ ...run, surface: catalog.surface }) === true;
    const now = moved ? deps.findDelegateRun?.(run.sessionId) : undefined;
    if (!now || "refusal" in now || now.run.surface !== catalog.surface) return partial(stays);
    const startedBy = deps.roles.ownerName;
    try {
      catalog.upsert({ conversationId: threadId, place, ownerId, live: { cli: run.cli, sessionId: run.sessionId } });
      const projectName = await projectLabel(run.projectPath, true);
      const cardActivityId = await fx.postCard(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "started" }));
      const pending: PendingLiveSession = {
        id: "desk", conversationId: threadId, proposedBy: startedBy, createdAt: Date.now(), cardActivityId,
        proposal: {
          // The recorded model; startLiveSessionAction keeps it only while clis.json still offers it.
          projectPath: run.projectPath, instruction: "", steering: "restricted", ...(run.model ? { model: run.model } : {}),
          resume: { sessionId: run.sessionId, projectPath: run.projectPath, instruction: run.instruction, cli: run.cli },
        },
      };
      // Not quiet: a refusal is posted in the thread, which is where the owner now looks.
      const result = await startLiveSessionAction(pending, startedBy, ownerId, fx, { place });
      return "ok" in result ? { ok: true, threadId } : { partial: true, threadId };
    } catch (err) {
      if (deps.liveSessions.has(threadId)) return { ok: true, threadId };
      return partial("The session moved here but didn't start — use Continue live to reopen it.", err);
    }
  }

  async function handleNoteAction(
    kind: "save-note" | "cancel-note",
    proposalId: string | undefined,
    actor: string,
    conversationId: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const held = deps.noteProposals.peek(proposalId);
    const pending = deps.noteProposals.claim(proposalId, conversationId);
    if (!pending) {
      recordExpired(held, conversationId, "note");
      await fx.post("That note draft expired — ask me to take the note again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled"): object =>
      deps.cards.noteResultCard({ title: pending.note.title, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-note") {
      recordCard(pending.conversationId, "note", "cancelled");
      await updateTo(resultCard("cancelled"));
      return;
    }
    let saved = false; // a failed card edit or receipt after the save isn't a failed save
    try {
      const body = pending.images?.length && deps.saveNoteImage
        ? await attachNoteImages(deps.saveNoteImage, pending.note.body, pending.images)
        : pending.note.body;
      await deps.saveNote({
        title: pending.note.title, body,
        project: pending.note.project, slug: pending.note.slug, source: "chat",
      });
      saved = true;
      recordCard(pending.conversationId, "note", "saved");
      await updateTo(resultCard("saved"));
      await fx.post(`Saved note "${pending.note.title}".`);
    } catch (err) {
      if (!saved) recordCard(pending.conversationId, "note", "failed");
      await fx.post(`Couldn't save the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleNoteArchiveAction(
    kind: "archive-note" | "cancel-archive-note",
    proposalId: string | undefined,
    actor: string,
    conversationId: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const held = deps.noteArchiveProposals.peek(proposalId);
    const pending = deps.noteArchiveProposals.claim(proposalId, conversationId);
    if (!pending) {
      recordExpired(held, conversationId, "note archive");
      await fx.post("That archive request expired — ask me again.");
      return;
    }
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-archive-note") {
      recordCard(pending.conversationId, "note archive", "cancelled");
      await updateTo(deps.cards.noteArchiveResultCard({ title: pending.title, by: actor, outcome: "cancelled" }));
      return;
    }
    let archived = false;
    try {
      if (!(await deps.archiveNote(pending.slug))) {
        recordCard(pending.conversationId, "note archive", "failed");
        await fx.post(`"${pending.title}" is already archived or gone.`);
        return;
      }
      archived = true;
      recordCard(pending.conversationId, "note archive", "archived");
      await updateTo(deps.cards.noteArchiveResultCard({ title: pending.title, by: actor, outcome: "archived", noteId: pending.slug }));
    } catch (err) {
      if (!archived) recordCard(pending.conversationId, "note archive", "failed");
      await fx.post(`Couldn't archive the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Restore button on an archive receipt. The note id rides the button (like Forget) and restore
  // is idempotent, so no proposal store.
  async function handleRestoreNote(slug: string | undefined, actor: string, fx: BotEffects): Promise<void> {
    if (!slug) return;
    try {
      const outcome = await deps.restoreNote(slug);
      await fx.post(outcome === "restored" ? `Restored (by ${actor}).`
        : outcome === "live" ? "Already restored." : "That note was permanently deleted — it can't be restored.");
    } catch (err) {
      await fx.post(`Couldn't restore the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleTodoAction(
    kind: "run-todo" | "queue-todo" | "cancel-todo",
    proposalId: string | undefined,
    action: CardAction,
    isOwner: boolean,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const actor = action.fromName;
    // Before the claim, so a refused tap leaves the card usable for its requester. Proposal ids
    // are sequential, so the conversation binding stops a forged id from another chat.
    const peeked = deps.todoProposals.peek(proposalId);
    if (peeked && (peeked.conversationId !== action.conversationId || (!isOwner && peeked.requesterId !== action.fromId))) {
      await fx.post("Only whoever asked for that todo (or the owner) can queue or cancel it.");
      return;
    }
    // Run now is the owner's alone (#923); the role gate already refused anyone else's tap.
    const sprouts = deps.routines?.sprouts;
    const queueDispatch = deps.queueTodoDispatch;
    if (kind === "run-todo" && (!isOwner || !sprouts || !queueDispatch)) {
      await fx.post(isOwner ? "Run now isn't available here — tap Queue." : "Only the owner can run a task now — tap Queue.");
      return;
    }
    const pending = deps.todoProposals.claim(proposalId);
    if (!pending) {
      recordExpired(peeked, action.conversationId, "todo", peeked?.todo.routine);
      await fx.post("That todo draft expired — ask me to queue it again.");
      return;
    }
    const resultCard = (outcome: "queued" | "cancelled", note?: string): object =>
      deps.cards.todoResultCard({ routine: pending.todo.routine, queuedBy: actor, outcome, ...(note ? { note } : {}) });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-todo") {
      recordCard(pending.conversationId, "todo", "cancelled", pending.todo.routine);
      await updateTo(resultCard("cancelled"));
      return;
    }
    const name = pending.todo.routine;
    const createdBy = pending.member ? pending.requesterId : undefined;
    let queued = false; // once queued, a failed card edit or receipt isn't a failed todo
    try {
      if (pending.report && queueDispatch) {
        // Queued with its dispatch: the todo's own result is posted back here when it runs.
        const q = await queueDispatch(
          { routine: name, text: pending.todo.text, ...(createdBy ? { createdBy } : {}), ...(kind === "run-todo" ? { front: true } : {}) },
          { ...pending.report, ...(action.fromId ? { actor: action.fromId } : {}) },
        );
        queued = true;
        if (kind === "run-todo" && sprouts) {
          let note: string;
          let state: CardRecordState = "queued"; // a start that didn't happen leaves it first in the queue
          try {
            const t = await sprouts.trigger(name, "todo", {}, q.jobId);
            if (t.status === "started") state = "running";
            note = t.status === "started" ? "Running only this task — I'll post the result here."
              : t.status === "next" ? `${name} is working on another task. Yours runs next, right after it.`
              : `Didn't start: ${t.status === "refused" ? t.reason : "unknown"}. It's first in the queue — I'll report here when it runs.`;
          } catch (err) {
            note = `Couldn't start: ${err instanceof Error ? err.message : String(err)}. It's first in the queue — I'll report here when it runs.`;
          }
          recordCard(pending.conversationId, "todo", state, name);
          await updateTo(resultCard("queued", note));
          await fx.post(note);
          return;
        }
        const note = "Queued — I'll report here when it runs.";
        recordCard(pending.conversationId, "todo", "queued", name);
        await updateTo(resultCard("queued", note));
        const when = q.routine ? todoRunHint(q.routine, new Date()) : "";
        await fx.post(`Queued on "${name}"${q.ahead ? ` (${q.ahead} ahead)` : ""}.${when ? ` ${when}` : ""} I'll report here when it runs.`);
        return;
      }
      const routine = await deps.queueTodo(name, pending.todo.text, createdBy);
      queued = true;
      recordCard(pending.conversationId, "todo", "queued", name);
      await updateTo(resultCard("queued"));
      const when = routine ? todoRunHint(routine, new Date()) : "";
      await fx.post(`Queued on "${name}".${when ? ` ${when}` : ""}`);
    } catch (err) {
      if (!queued) recordCard(pending.conversationId, "todo", "failed", name);
      await fx.post(`Couldn't queue the todo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSkillAction(
    kind: "save-skill" | "cancel-skill",
    proposalId: string | undefined,
    actor: string,
    conversationId: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const held = deps.skillProposals.peek(proposalId);
    const pending = deps.skillProposals.claim(proposalId);
    if (!pending) {
      recordExpired(held, conversationId, "skill", held?.skill.name);
      await fx.post("That skill draft expired — ask me to draft it again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled"): object =>
      deps.cards.skillResultCard({ name: pending.skill.name, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-skill") {
      recordCard(pending.conversationId, "skill", "cancelled", pending.skill.name);
      await updateTo(resultCard("cancelled"));
      return;
    }
    let saved = false;
    try {
      await deps.saveSkill(pending.skill.name, pending.skill.body);
      saved = true;
      recordCard(pending.conversationId, "skill", "saved", pending.skill.name);
      await updateTo(resultCard("saved"));
      await fx.post(`Saved skill "${pending.skill.name}".`);
    } catch (err) {
      if (!saved) recordCard(pending.conversationId, "skill", "failed", pending.skill.name);
      await fx.post(`Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Owner-DM send cards (#689): only this surface's labelled destinations, so a Discord card never
  // lists Teams rows and vice versa. Option ids are opaque; the proposal maps them back to rows.
  function sendRows(send: NonNullable<TeamsBotDeps["send"]>): Array<{ row: Destination; label: string }> {
    const rows = send.destinations().filter((r) => r.surface === send.transport);
    return rows.flatMap((row) => {
      const label = destinationLabel(row, rows);
      return label ? [{ row, label }] : [];
    });
  }
  const sameKey = (a: DestinationKey, b: DestinationKey): boolean => a.surface === b.surface && a.conversationId === b.conversationId;

  // The caller has checked owner + real DM. The card is ordered pick → aliased → most recently
  // seen (Discord shows the first 25, so the pick is never cut), pre-picked only on a confident match.
  async function postSendCard(proposed: ProposedSend, msg: IncomingMessage, fx: BotEffects): Promise<void> {
    const send = deps.send;
    if (!send || !deps.cards.sendCard) return;
    // The card must show everything Send posts, so a body too long to preview is refused.
    if (proposed.text.length > MAX_SEND_CHARS) {
      await fx.post(`That message is too long to confirm on a card (over ${MAX_SEND_CHARS} characters) — shorten it and ask again.`);
      return;
    }
    const all = sendRows(send);
    if (all.length === 0) {
      await fx.post("I don't know any conversations to send to yet — mention me in one once, and it shows up in Bean's Settings → ChatOps.");
      return;
    }
    const { pick } = matchDestination(proposed.destination, all.map((e) => e.row));
    const rank = (row: Destination): number => (pick && sameKey(row, pick) ? 0 : row.alias ? 1 : 2);
    const ordered = [...all].sort((a, b) => rank(a.row) - rank(b.row) || b.row.lastSeen.localeCompare(a.row.lastSeen));
    const rows = new Map<string, DestinationKey>();
    const options = ordered.map(({ row, label }, i) => {
      const id = String(i);
      rows.set(id, { surface: row.surface, conversationId: row.conversationId });
      return { id, label, detail: [row.platformName, row.parentName, SEND_KIND[row.kind]].filter(Boolean).join(" · ") };
    });
    const pickId = pick ? [...rows].find(([, key]) => sameKey(key, pick))?.[0] : undefined;
    const p = send.proposals.add({
      conversationId: msg.conversationId, proposedById: msg.fromId, body: proposed.text, rows, ...(pickId ? { pick: pickId } : {}),
    });
    const activityId = await fx.postCard(deps.cards.sendCard({ proposalId: p.id, body: proposed.text, options, ...(pickId ? { pick: pickId } : {}) }));
    send.proposals.setCardActivityId(p.id, activityId);
    recordCard(msg.conversationId, "send", "pending");
  }

  // Send / Cancel / (Discord) a destination pick on a send card. The role was checked before this
  // (owner); the real-DM flag and the proposer/conversation binding are checked before the pending
  // proposal is touched, so a refused tap leaves it unchanged. Send re-resolves the row now and
  // posts the body frozen on the card.
  async function handleSendAction(
    kind: "send-confirm" | "send-cancel" | "send-pick", action: CardAction, fx: BotEffects,
  ): Promise<void> {
    const send = deps.send;
    const { proposalId, destination } = action.value;
    if (!send || !proposalId) return;
    // Privacy is never inferred: a missing flag (or a shared chat) refuses.
    if (action.direct !== true) {
      await fx.post("I only send from your DM with me — ask me there.");
      return;
    }
    const peek = send.proposals.peek(proposalId);
    if (!peek) {
      if (kind !== "send-pick") await fx.post(SEND_EXPIRED);
      return;
    }
    if (peek.conversationId !== action.conversationId || ![action.fromId, action.fromAltId].includes(peek.proposedById)) {
      await fx.post("Only whoever asked for that send can confirm it, in the chat they asked in.");
      return;
    }
    if (kind === "send-pick") {
      if (destination) send.proposals.setPick(proposalId, destination);
      return;
    }
    const settle = async (p: { cardActivityId?: string; body: string }, result: string): Promise<void> => {
      if (p.cardActivityId !== undefined && deps.cards.sendCard) {
        await fx.updateCard(p.cardActivityId, deps.cards.sendCard({ proposalId, body: p.body, options: [], result }));
      } else await fx.post(result);
    };
    if (kind === "send-cancel") {
      const p = send.proposals.claim(proposalId);
      recordCard(peek.conversationId, "send", p ? "cancelled" : "expired");
      if (!p) await fx.post(SEND_EXPIRED);
      else await settle(p, `Cancelled (by ${action.fromName})`);
      return;
    }
    // Teams submits its ChoiceSet (empty = nothing picked); Discord's select already set the pick.
    const pick = destination ?? peek.pick;
    if (!pick) {
      await fx.post("Pick a destination first.");
      return;
    }
    const key = peek.rows.get(pick);
    if (!key || key.surface !== send.transport) {
      await fx.post("That destination wasn't on this card.");
      return;
    }
    const now = sendRows(send).find((e) => sameKey(e.row, key));
    if (!now) {
      await fx.post("That conversation isn't known any more — pick another.");
      return;
    }
    const p = send.proposals.claim(proposalId);
    if (!p) {
      recordCard(peek.conversationId, "send", "expired");
      await fx.post(SEND_EXPIRED);
      return;
    }
    try {
      await send.enqueue({ transport: key.surface, channel: key.conversationId, body: p.body });
    } catch (err) {
      recordCard(p.conversationId, "send", "failed");
      await settle(p, `Couldn't queue it: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    recordCard(p.conversationId, "send", "sent");
    await settle(p, `Queued → ${now.label}`);
  }

  // Run/Check or Cancel on a sprout-run card. The role was checked before this (owner); the
  // conversation and asker bindings are checked before the claim, so a refused tap leaves the
  // card usable. A tap triggers exactly the action frozen on the card.
  async function handleSproutAction(
    kind: "run-sprout" | "cancel-sprout", proposalId: string | undefined, action: CardAction, fx: BotEffects,
  ): Promise<void> {
    const sprouts = deps.routines?.sprouts;
    if (!proposalId || !sprouts) return;
    const peek = sprouts.proposals.peek(proposalId);
    if (peek && (peek.conversationId !== action.conversationId || ![action.fromId, action.fromAltId].includes(peek.proposedById))) {
      await fx.post("Only whoever asked for that sprout run can confirm it, in the chat they asked in.");
      return;
    }
    const pending = sprouts.proposals.claim(proposalId);
    if (!pending) {
      recordExpired(peek, action.conversationId, "sprout", peek?.plan.routine);
      await fx.post("That sprout card expired — ask me again.");
      return;
    }
    const { plan } = pending;
    const settle = async (result: string): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, deps.cards.sproutRunCard({ proposalId, plan, result }));
    };
    if (kind === "cancel-sprout") {
      recordCard(pending.conversationId, "sprout", "cancelled", plan.routine);
      await settle(`Cancelled (by ${action.fromName})`);
      return;
    }
    let result: string;
    let state: CardRecordState = "didn't start";
    try {
      const t = await sprouts.trigger(plan.routine, plan.action, { ...(pending.channel ? { channel: pending.channel } : {}), ...(action.fromId ? { actor: action.fromId } : {}) });
      if (t.status === "started") state = "running";
      else if (t.status === "checked") state = "checked";
      result = t.status === "started" ? "Started — I'll post the result here."
        : t.status === "checked" ? sproutCheckText(t.result, plan.queuesNew) : `Didn't start: ${t.status === "refused" ? t.reason : "busy"}`;
    } catch (err) {
      result = `Couldn't start: ${err instanceof Error ? err.message : String(err)}`;
    }
    recordCard(pending.conversationId, "sprout", state, plan.routine);
    await settle(result);
  }

  async function runRoutineCommand(c: RoutineCommand): Promise<string> {
    const r = deps.routines!;
    const nowT = new Date();
    // Archived sprouts read as gone here (#980); restoring one is a desktop job.
    const all = (await r.load()).filter((x) => !isArchived(x, nowT));
    if (c.kind === "list") {
      const [projects, skills] = await Promise.all([deps.loadProjects(), deps.loadSkills()]);
      const disabled = new Set(skills.filter((s) => s.enabled === false).map((s) => s.name));
      return routineListText(all, projects, new Set(skills.map((s) => s.name)), undefined, r.sprouts !== undefined, disabled);
    }
    // Exact name, else a unique case-insensitive match (phones capitalize the first letter).
    const loose = all.filter((x) => x.name.toLowerCase() === c.name.toLowerCase());
    const target = all.find((x) => x.name === c.name) ?? (loose.length === 1 ? loose[0] : undefined);
    if (!target) return `No sprout named "${c.name}". Say \`sprouts\` to list them.`;
    const on = c.kind === "enable";
    if (target.enabled === on) return `"${target.name}" is already ${on ? "on" : "off"}.`;
    const next = { ...target, enabled: on };
    // Past its end it would only expire again on the next tick: a later end is set on the desktop.
    if (on && isExpired(next, nowT)) return `"${target.name}" ended ${untilLabel(target.until)} — give it a later end date on the desktop to turn it back on.`;
    await r.save(next);
    return on ? `Turned "${target.name}" on. ${todoRunHint(next, nowT)}`.trim() : `Turned "${target.name}" off.`;
  }

  async function handleRoutineAction(
    kind: "save-routine" | "cancel-routine" | "toggle-routine",
    proposalId: string | undefined,
    action: CardAction,
    role: Role,
    fx: BotEffects,
  ): Promise<void> {
    const r = deps.routines;
    if (!proposalId || !r) return;
    const expired = "That sprout draft expired — ask me to draft it again.";
    const held = r.proposals.peek(proposalId);
    const peek = r.proposals.get(proposalId);
    if (!peek) {
      if (kind !== "toggle-routine") recordExpired(held, action.conversationId, "sprout draft", held ? String(held.proposal.routine.name) : undefined);
      await fx.post(expired);
      return;
    }
    if (peek.conversationId !== action.conversationId) {
      await fx.post("That draft belongs to another conversation.");
      return;
    }
    // Bound to the proposer (checked before claim, so the draft stays usable): another admin
    // in the same channel can't save or cancel it.
    const isOwner = role === "owner";
    if (!isOwner && action.fromId !== peek.proposedById) {
      await fx.post(routineDraftRefusal(peek.proposedBy, deps.roles));
      return;
    }
    const recipients = await r.recipients();
    const updateTo = async (card: object | undefined): Promise<void> => {
      if (card && peek.cardActivityId !== undefined) await fx.updateCard(peek.cardActivityId, card);
    };
    if (kind === "toggle-routine") {
      if (peek.proposal.problem || !deps.cards.routineProposalCard) return;
      peek.proposal = { ...peek.proposal, routine: { ...peek.proposal.routine, enabled: !peek.proposal.routine.enabled } };
      await updateTo(deps.cards.routineProposalCard(routineCardInput(peek, recipients, deps.roles.ownerName)));
      return;
    }
    const pending = r.proposals.claim(proposalId);
    if (!pending) {
      recordCard(peek.conversationId, "sprout draft", "expired", String(peek.proposal.routine.name));
      await fx.post(expired);
      return;
    }
    // A non-owner's Save always lands switched off, whatever the draft (or a forged toggle) says.
    // Home only from the owner's own draft, saved in their 1:1 (the card is bound to its conversation).
    const drafted = pending.proposal.problem
      ? pending.proposal.routine : draftHome(pending.proposal.routine, isOwner && pending.byOwner && action.direct === true);
    const routine = isOwner ? drafted : { ...drafted, enabled: false };
    const name = String(routine.name);
    const resultCard = (outcome: "saved" | "cancelled" | "failed", problem?: string): object | undefined =>
      deps.cards.routineResultCard?.({ name, by: action.fromName, outcome, enabled: routine.enabled, ...(problem ? { problem } : {}) });
    if (kind === "cancel-routine") {
      recordCard(pending.conversationId, "sprout draft", "cancelled", name);
      await updateTo(resultCard("cancelled"));
      return;
    }
    const fail = async (problem: string): Promise<void> => {
      recordCard(pending.conversationId, "sprout draft", "failed", name);
      await updateTo(resultCard("failed", problem));
      await fx.post(`Couldn't save the sprout: ${problem}`);
    };
    // Re-validated at save: the household or clis.json may have changed while the card sat.
    const problem = pending.proposal.problem ?? chatRoutineProblem(routine, r.transport, recipients, deps.cliModels, pending.channelId, r.destinations?.());
    if (problem) {
      await fail(problem);
      return;
    }
    if (hasEnded(routine, new Date())) {
      await fail("its end date has passed — ask me again with a later one");
      return;
    }
    // An admin's draft never replaces a routine: case-insensitive check here (the filesystem may
    // be case-sensitive), then a create-only write for the race.
    const createOnly = !isOwner || !pending.byOwner;
    if (createOnly && (await r.load()).some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      await fail(nameTaken(name));
      return;
    }
    const saved = createOnly ? undefined : (await r.load()).find((x) => x.name === name);
    if (!createOnly && (saved === undefined ? undefined : JSON.stringify(saved)) !== pending.prior) {
      await fail(`"${name}" changed since this card — ask me again`);
      return;
    }
    try {
      if (createOnly) await r.create(routine);
      else {
        // Replacing a sprout keeps its display-only "Listed under", and a draft without Home keeps the
        // saved Home sink.
        const next = saved?.projects && routine.projects === undefined ? { ...routine, projects: saved.projects } : routine;
        const home = next.sinks.home ?? saved?.sinks.home;
        await r.save(home ? { ...next, sinks: { ...next.sinks, home } } : next);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") await fail(nameTaken(name));
      else {
        recordCard(pending.conversationId, "sprout draft", "failed", name);
        await fx.post(`Couldn't save the sprout: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    recordCard(pending.conversationId, "sprout draft", "saved", name);
    if (!isOwner) {
      // Queued right after the write, before any card/reply effect that could throw.
      try {
        await r.notifyOwner(ownerDraftNotice({ ...pending, proposedBy: action.fromName }, recipients, deps.roles.ownerName));
      } catch (err) {
        console.error("routines: owner draft notice failed", err);
      }
    }
    await updateTo(resultCard("saved"));
    if (!isOwner) {
      // Never claim the owner was told: the DM is queued, not delivered.
      await fx.post(`Saved "${name}" (off). Ask ${deps.roles.ownerName} to run \`enable ${name}\`.`);
      return;
    }
    await fx.post(routine.enabled
      ? `Saved sprout "${name}" — it's on. ${todoRunHint(routine, new Date())}`.trim()
      : `Saved sprout "${name}" — it's off. Say \`enable ${name}\` to turn it on.`);
  }

  // Forget button on a remembered card. The id rides the button itself and delete is
  // idempotent, so no proposal store: a second tap (or a stale card) just says so.
  // A member forgets only their own private facts; the owner (`subject` undefined) forgets any.
  async function handleForget(memoryId: string | undefined, actor: string, subject: string | undefined, fx: BotEffects): Promise<void> {
    if (!memoryId) return;
    const text = (await deps.loadMemories()).find((m) => m.id === memoryId)?.text;
    const gone = await deps.deleteMemories([memoryId], subject);
    if (gone.length > 0) await fx.post(`Forgot (by ${actor}): ${text ?? "that fact"}`);
    else await fx.post(text === undefined ? "Already forgotten." : "Only the owner can forget shared facts or another member's.");
  }

  // Share button on a private remembered card. Same id-in-the-button, no-proposal-store shape as
  // Forget; the SQL only flips the tapper's own private row, so the owner gets no bypass either.
  // The reply text comes from the stored row, never the card payload.
  async function handleShare(memoryId: string | undefined, actor: string, actorId: string, fx: BotEffects): Promise<void> {
    if (!memoryId) return;
    if (await deps.shareMemory(memoryId, actorId) === 0) {
      await fx.post("Nothing changed — already shared or forgotten.");
      return;
    }
    const text = (await deps.loadMemories(null, { allSources: true })).find((m) => m.id === memoryId)?.text;
    await fx.post(`Shared with everyone (by ${actor}): ${text ?? "that fact"}. Only the owner can forget it now.`);
  }

  // Cancel button on a reminder receipt: same idempotent, no-proposal-store shape as Forget.
  // `setBy` set = only that person's reminder (non-owners); checked inside the locked update.
  async function handleCancelReminder(reminderId: string | undefined, actor: string, fromId: string, conversationId: string, setBy: string | undefined, fx: BotEffects): Promise<void> {
    if (!reminderId || !deps.reminders) return;
    const res = await cancelReminder(deps.reminders.file, reminderId, setBy);
    // Echo the text only into the conversation it belongs to (or the setter's own DM).
    const t = res.target as { userId?: unknown } | undefined;
    const here = reminderInConversation(res.target, deps.reminders.transport, conversationId) ||
      (typeof t?.userId === "string" && t.userId === fromId);
    if (res.outcome === "cancelled") await fx.post(here ? `Reminder cancelled (by ${actor}): ${res.text ?? ""}` : `Reminder cancelled (by ${actor}).`);
    else await fx.post(res.outcome === "forbidden"
      ? "Only whoever set that reminder (or the owner) can cancel it."
      : "That reminder already fired or was cancelled.");
  }

  // Post a live-session proposal from a verbatim instruction — no converse()/LLM in the path, so
  // the prompt reaches the card (and then claude) exactly as typed. Shared by the /live-session
  // slash command and its literal-text form in onMessage. Returns a one-line status for the caller.
  async function proposeLiveSessionFrom(conversationId: string, instruction: string, proposedBy: string, fx: BotEffects): Promise<string> {
    if (!deps.liveSessionsEnabled()) return "Live sessions are disabled here.";
    const running = deps.liveSessions.cli(conversationId);
    if (running) return liveBusyLine(running);
    const text = instruction.trim();
    if (!text) return "Add a prompt after `/live-session` — e.g. `/live-session investigate the auth bug`.";
    // `resume <id>` never falls through to a fresh session, even when the id is malformed.
    const resumeCmd = /^resume\b([\s\S]*)$/i.exec(text);
    if (resumeCmd) {
      const parsed = parseResumeArg(resumeCmd[1] ?? "");
      if ("error" in parsed) return parsed.error;
      return await proposeResumeLive(conversationId, parsed.id, proposedBy, fx)
        ?? "Proposed continuing that session — tap Start, then type to pick up where it left off.";
    }
    const projects = await deps.loadProjects();
    const first = projects[0];
    if (!first) return "No projects are configured — add one first.";
    // Project/model are picked on the card; to the last started session's project, else the first (user can switch).
    const live: ProposedLiveSession = { projectPath: first.path, instruction: text };
    await fx.post(CARD_LEAD); // no converse() in this path, so no sentence of the model's (#978)
    await postLiveSessionProposal(live, conversationId, proposedBy, fx, true);
    return "Proposed a live session — pick the project/model, edit the prompt if you want, then Start.";
  }

  // Keyword commands accept an optional leading slash: Discord exposes them as real slash
  // commands and users carry the habit to Teams, where they arrive as plain text that must still
  // match. Surface-agnostic normalized form (the `live-session` regex does its own slash match).
  const commandWord = (text: string): string => text.trim().toLowerCase().replace(/^\/+/, "");

  // DMs never have admins; the scope is what admin grants hang off.
  function speakerRole(msg: IncomingMessage): { role: Role; scopeId: string | undefined } {
    const scopeId = msg.direct ? undefined : msg.scopeId;
    const role = deps.roles.roleOf({ fromId: msg.fromId, fromAltId: msg.fromAltId, scopeId });
    if (role === "admin") deps.roles.touch(scopeId, msg.fromId, msg.fromName);
    return { role, scopeId };
  }

  async function dmBlocked(msg: IncomingMessage, role: Role, fx: BotEffects): Promise<boolean> {
    if (!msg.direct || dmAllowed(role, deps.roles)) return false;
    if (firstRefusal(`dm:${msg.fromId}`)) await fx.reply(dmRefusal(deps.roles));
    return true;
  }

  // The runtime check behind every write: refuses (and says so) when the role is short.
  const permittedFor = (role: Role, scopeId: string | undefined, fx: BotEffects) =>
    async (cap: Capability, what: string): Promise<boolean> => {
      if (can(role, cap)) return true;
      await fx.reply(refusal(needs(cap), role, what, deps.roles, scopeId));
      return false;
    };

  // Who may steer the bound live session. Bystanders in restricted mode are kept out of the
  // agent. Members never steer (not even in war-room mode or as a co-driver): live sessions
  // bypass permissions, which is past a member's powers.
  const steers = (msg: IncomingMessage): boolean =>
    deps.liveSessions.canSteer(msg.conversationId, msg.fromId) &&
    deps.roles.roleOf({ fromId: msg.fromId, fromAltId: msg.fromAltId, scopeId: msg.direct ? undefined : msg.scopeId }) !== "member";

  // Chatty on/off need admin; status, mute and unmute are open to anyone addressed. Never a model call.
  async function runChatterCommand(chatter: Chatter, c: ChatterCommand, msg: IncomingMessage, fx: BotEffects): Promise<void> {
    const { role, scopeId } = speakerRole(msg);
    if (await dmBlocked(msg, role, fx)) return;
    if (!scopeId) {
      await fx.reply(c.kind === "memory" ? "Channel memory is per channel — run this in a channel, not a DM."
        : "Chatty mode is per channel — run this in a channel, not a DM.");
      return;
    }
    if (c.kind === "memory") {
      if (c.arg === "status") {
        await fx.reply(chatter.memoryOn(scopeId) ? "Channel memory is on here — I remember facts people share. `memory off` to stop."
          : "Channel memory is off here — I only remember what someone explicitly asks me to.");
        return;
      }
      if (!(await permittedFor(role, scopeId, fx)("channelMemory", "turn channel memory on or off"))) return;
      chatter.setMemoryOn(scopeId, c.arg === "on");
      await (fx.announce ?? fx.reply)(c.arg === "on"
        ? `Channel memory is on${msg.channelName ? ` in ${msg.channelName}` : ""} — I'll remember facts people share here.`
        : "Channel memory is off — I'll only remember what someone explicitly asks me to.");
      return;
    }
    const state = chatter.get(scopeId);
    const now = Date.now();
    const muted = state.mutedUntil !== undefined && state.mutedUntil > now;
    if (c.kind === "chatty") {
      if (c.arg === "status") {
        await fx.reply(!state.enabled ? "Chatty mode is off here — I only answer when addressed."
          : muted ? `Chatty mode is on here, but I'm muted until ${formatMuteEnd(state.mutedUntil!)}.`
          : "Chatty mode is on here — I may chime in when I can help.");
        return;
      }
      if (!(await permittedFor(role, scopeId, fx)("chatty", "turn chatty mode on or off"))) return;
      chatter.setEnabled(scopeId, c.arg === "on");
      if (c.arg === "on") {
        await (fx.announce ?? fx.reply)(`Chatty mode is on${msg.channelName ? ` in ${msg.channelName}` : ""} — ` +
          "I may chime in when I can help. Mention me with `quiet 30m` to mute me for a while, or `unmute`.");
      } else {
        await fx.reply("Chatty mode is off — I'll only answer when addressed.");
      }
      return;
    }
    if (!state.enabled) {
      await fx.reply(NOT_CHATTY);
      return;
    }
    if (c.kind === "unmute") {
      chatter.setMutedUntil(scopeId, undefined);
      await fx.reply(muted ? "Unmuted — I may chime in again." : "I wasn't muted.");
      return;
    }
    const until = now + c.minutes * 60_000;
    chatter.setMutedUntil(scopeId, until);
    await fx.reply(`Okay, I'll stay quiet until ${formatMuteEnd(until)} unless addressed.`);
  }

  // The CHATOPS_COMMANDS keyword commands, without text-parsing side paths: never calls the model
  // and never forwards to a live CLI. Returns false for anything else (the caller's turn).
  async function onCommand(msg: IncomingMessage, fx: BotEffects): Promise<boolean> {
    const cmd = commandWord(msg.text);
    const conv = msg.conversationId;
    if (cmd === "stop" || cmd === "drivers") {
      if (!deps.liveSessions.has(conv)) {
        await fx.reply("No live session running here.");
        return true;
      }
      if (!steers(msg)) return true;
      if (cmd === "drivers") {
        const co = deps.liveSessions.coDrivers(conv);
        await fx.reply(co.length === 0 ? "No co-drivers yet." : `Co-drivers: ${co.length}.`);
      } else {
        deps.liveSessions.stop(conv); // the registry's onEnded posts the end notice
      }
      return true;
    }
    if (cmd === "continue") {
      if (speakerRole(msg).role !== "owner") await fx.reply("Only the owner can continue a live session.");
      // The main conversation (#998) resumes only through a card: `/continue` posts the confirm card
      // for the session last bound here (the same one Continue live posts), never reopens it directly.
      else if (msg.direct && historyId(conv) === MAIN_CONVERSATION_ID) {
        const sessionId = deps.catalog?.get(conv)?.liveSessionId;
        const refused = sessionId ? await proposeResumeLive(conv, sessionId, msg.fromName, fx) : MAIN_CONTINUE_NONE;
        if (refused) await fx.reply(refused);
      }
      else if (!deps.liveSessionsEnabled()) await fx.reply("Live sessions are disabled here.");
      else {
        const r = await resumeBoundLive(conv, async () => fx);
        // On success the mode line is the answer (posted by startLiveSessionAction).
        if ("refused" in r) await fx.reply(CONTINUE_REFUSED[r.refused] ?? "I couldn't reopen that session.");
      }
      return true;
    }
    const awayCmd = deps.away ? parseAwayCommand(msg.text) : undefined;
    if (deps.away && awayCmd) {
      // Owner + real DM only (a Teams targeted `/` pick isn't `direct`). Everyone else hears one
      // fixed line that never reveals the state. Never a model call.
      const ok = msg.direct && can(speakerRole(msg).role, "away");
      await fx.reply(ok ? runAwayCommand(deps.away, awayCmd, Date.now()) : awayRefusal(deps.roles.ownerName));
      return true;
    }
    const chatterCmd = deps.chatter ? parseChatterCommand(msg.text) : undefined;
    // In a DM, mute/unmute stay model turns (the owner may mean the Mac's volume).
    if (deps.chatter && chatterCmd && (chatterCmd.kind === "chatty" || chatterCmd.kind === "memory" || !msg.direct)) {
      await runChatterCommand(deps.chatter, chatterCmd, msg, fx);
      return true;
    }
    const roleCmd = parseRoleCommand(msg.text);
    const routineCmd = deps.routines ? parseRoutineCommand(msg.text) : undefined;
    const liveCmd = /^\/?live-session\b\s*([\s\S]*)$/i.exec(msg.text.trim());
    if (!roleCmd && !routineCmd && !liveCmd && cmd !== "cancel" && cmd !== "new") return false;
    const { role, scopeId } = speakerRole(msg);
    const isOwner = role === "owner";
    if (roleCmd === "whoami") {
      const as = { owner: "the owner", admin: "an admin", member: "a member", guest: "a guest" }[role];
      await fx.reply(`You're ${as} here. ` +
        `Your id: ${msg.fromId}${msg.fromAltId ? ` (AAD object id: ${msg.fromAltId})` : ""}.` +
        (scopeId ? ` This chat's id: \`${scopeId}\`.` : ""));
      return true;
    }
    if (roleCmd === "admins") {
      const names = deps.roles.admins(scopeId).map((a) => a.name);
      await fx.reply(`Owner: ${deps.roles.ownerName}. Admins here: ${names.length > 0 ? names.join(", ") : "none"}.`);
      return true;
    }
    if (await dmBlocked(msg, role, fx)) return true;
    const permitted = permittedFor(role, scopeId, fx);
    if (roleCmd === "add-admin" || roleCmd === "remove-admin") {
      if (!(await permitted("manageAdmins", "change admins"))) return true;
      if (!scopeId) {
        await fx.reply("Admins are per channel or group chat — run this there, not in a DM.");
        return true;
      }
      const targets = msg.mentions ?? [];
      if (targets.length === 0) {
        await fx.reply(`@mention who to ${roleCmd === "add-admin" ? "add" : "remove"}, e.g. \`${roleCmd} @name\`.`);
        return true;
      }
      const changed = roleCmd === "add-admin"
        ? deps.roles.addAdmins(scopeId, targets)
        : deps.roles.removeAdmins(scopeId, targets.map((t) => t.id));
      if (changed.length === 0) {
        await fx.reply("No change — already set that way.");
        return true;
      }
      const names = targets.filter((t) => changed.includes(t.id)).map((t) => t.name).join(", ");
      // A real change is the chat's business: announce it publicly where the surface can.
      await (fx.announce ?? fx.reply)(roleCmd === "add-admin"
        ? `Added ${names} as admin${changed.length > 1 ? "s" : ""}${msg.channelName ? ` in ${msg.channelName}` : ""}.`
        : `Removed ${names}.`);
      return true;
    }
    if (cmd === "cancel") {
      if (!(await permitted("cancelRuns", "cancel runs"))) return true;
      // Admins stop only this conversation's runs; the owner stops everything.
      const n = deps.runs.cancelAll(isOwner ? undefined : conv);
      await fx.reply(n > 0 ? `Cancelled ${n} run(s).` : "Nothing is running.");
      return true;
    }
    if (cmd === "new") {
      if (!(await permitted("fresh", "start a fresh conversation"))) return true;
      // Ends this conversation's task grant even where the history doesn't reset (the owner's DM),
      // and counts the reset there too, so a run confirmed before it can't grant once it settles.
      const held = grants.get(conv);
      if (held) grants.set(conv, { ...held, grant: revokeGrant(held.grant) });
      resets.set(conv, (resets.get(conv) ?? 0) + 1);
      // The owner's DM is part of the one ongoing conversation (#998): it never resets.
      if (msg.direct && isOwner && deps.mainLog?.cutover()) {
        const { name } = await deps.loadPersona();
        await fx.reply(`This DM is part of your ongoing chat with ${name} — it doesn't reset. ` +
          "For a fresh topic use a channel or a new task chat on the desktop.");
        return true;
      }
      const archived = deps.conversations.clear(conv);
      deps.noteProposals.forgetImages(conv);
      // Also fence off pre-reset channel chatter so it can't leak back in as ambient.
      deps.conversations.setAmbientCutoff(conv, Date.now());
      await fx.reply(archived
        ? "Fresh start — I've reset my context here. The earlier conversation stays in the desktop app's chat history."
        : "Fresh start — I've cleared this conversation's context.");
      return true;
    }
    if (routineCmd) {
      if (role === "admin") {
        await fx.reply(routineAdminRefusal(deps.roles));
        return true;
      }
      if (!(await permitted("routineWrites", "manage sprouts"))) return true;
      await fx.reply(await runRoutineCommand(routineCmd));
      return true;
    }
    // Literal `/live-session <prompt>` typed as a message (not Discord's slash-command picker):
    // route it verbatim, bypassing converse(), so the LLM never rewrites the prompt the way it
    // does for free-form "start a live session…" phrasing.
    if (!(await permitted("liveSession", "start a live session"))) return true;
    await fx.reply(await proposeLiveSessionFrom(conv, liveCmd?.[1] ?? "", msg.fromName, fx));
    return true;
  }

  // Refused text (a per-turn CLI's next-turn queue is full) never reaches history. Images are
  // staged to files and the agent gets `[Image #N]: /abs/path` lines (all three CLIs read an
  // image by path); history saves `[image attached]`, never a path.
  // `stillSteers` re-checks the sender after the staging await.
  async function steerLive(
    conv: string, fromName: string, text: string, images?: ImageAttachment[], stillSteers: () => boolean = () => true,
  ): Promise<boolean> {
    let agentText = text;
    if (images?.length) {
      const run = deps.liveSessions.generation(conv);
      const dir = join(deps.liveImagesDir ?? join(tmpdir(), "bean-live-images"), createHash("sha256").update(conv).digest("hex").slice(0, 16));
      const paths = await stageImages(images, dir);
      // The session ended, was replaced, or the sender lost steering while staging: nothing is
      // steered; the files are left for the OS purge.
      if (deps.liveSessions.generation(conv) !== run || !stillSteers()) return true;
      const first = deps.liveSessions.takeImageNumbers(conv, paths.length);
      if (first === undefined) return true;
      agentText = [text, ...paths.map((p, i) => `[Image #${first + i}]: ${p}`)].filter(Boolean).join("\n");
    }
    const run = deps.liveSessions.generation(conv);
    if (!deps.liveSessions.send(conv, agentText)) return false;
    const saved = images?.length ? [text, "[image attached]"].filter(Boolean).join("\n") : text;
    noteLiveTurn(conv, run, { role: "user", content: saved });
    appendHistory(conv, { role: "user", content: speakerLine(fromName, saved) });
    return true;
  }

  // Desk turns running right now, across conversations — the bot-busy cap.
  // ponytail: one global cap; per-conversation if the desk ever sends in bulk.
  let deskInFlight = 0;
  const MAX_DESK_IN_FLIGHT = 4;
  // Desk Continue live clicks between their checks and the registry's bind (effects() awaits): a
  // second one for the same conversation is channel-busy, never a second session.
  const deskResuming = new Set<string>();

  // Reopens the conversation's ended owner-started live session from its catalog binding, with
  // no card: the desk's Continue live click, or the owner's `continue` here, is the confirmation.
  // CLI, session id and project come from the catalog row and `findDelegateRun`, never the caller.
  // `getFx` is only called once the request is eligible. Never starts a fresh session.
  async function resumeBoundLive(conv: string, getFx: () => Promise<BotEffects>): Promise<DeskAckResult> {
    const catalog = deps.catalog;
    const row = catalog?.get(conv);
    if (!catalog || !row || row.archivedFrom) return { refused: "no-record" };
    const owner = { fromId: row.ownerId, fromAltId: row.ownerAltId };
    if (deps.roles.roleOf(owner) !== "owner") return { refused: "not-eligible" };
    if (deps.liveSessions.has(conv) || deskResuming.has(conv)) return { refused: "channel-busy" };
    // The catalog binding and the delegate_runs row must agree on surface, CLI and session; the
    // project comes from the row (findDelegateRun checks the folder still exists). A
    // conversation with no recorded session never starts fresh.
    const found = row.liveCli && row.liveSessionId ? deps.findDelegateRun?.(row.liveSessionId) : undefined;
    if (!found || "refusal" in found || found.run.surface !== catalog.surface || found.run.cli !== row.liveCli) {
      return { refused: "no-record" };
    }
    const { run } = found;
    if (!isLiveCli(run.cli)) return { refused: "no-record" };
    if (!liveClis().includes(run.cli)) return { refused: "cli-missing" };
    deskResuming.add(conv);
    try {
      let fx: BotEffects;
      try {
        fx = await getFx();
      } catch (err) {
        console.warn("bean: live resume target failed:", err instanceof Error ? err.name : "error");
        return { refused: "post-failed" };
      }
      const startedBy = deps.roles.ownerName;
      const pending: PendingLiveSession = {
        id: "desk", conversationId: conv, proposedBy: startedBy, createdAt: Date.now(),
        proposal: {
          projectPath: run.projectPath, instruction: "", steering: "restricted",
          resume: { sessionId: run.sessionId, projectPath: run.projectPath, instruction: run.instruction, cli: run.cli },
        },
      };
      try {
        return await startLiveSessionAction(pending, startedBy, row.ownerId, fx,
          { altId: row.ownerAltId, place: { kind: row.kind, title: row.title } }, true);
      } catch (err) {
        // The mode line's post failed after the bind: the session is open all the same.
        console.warn("bean: live resume post failed:", err instanceof Error ? err.name : "error");
        return deps.liveSessions.has(conv) ? { ok: true } : { refused: "post-failed" };
      }
    } finally {
      deskResuming.delete(conv);
    }
  }

  const bot: ReturnType<typeof buildTeamsBot> = {
    onCommand,

    async onDeskTurn(req, effects, ack): Promise<void> {
      const conv = req.conversationId;
      const text = req.text.trim();
      if (text.length > MAX_DESK_TEXT) return ack({ refused: "too-long" });
      const row = deps.catalog?.get(conv);
      // An archive (`/new`'s copy of earlier history) is read-only.
      if (!row || row.archivedFrom) return ack({ refused: "no-record" });
      // The id to act as is the one the catalog recorded, never one the request names, and it
      // must still be the configured owner (a changed owner config hides the old owner's rows).
      const owner = { fromId: row.ownerId, fromAltId: row.ownerAltId };
      if (deps.roles.roleOf(owner) !== "owner") return ack({ refused: "not-eligible" });
      // The owner's DM is part of the main conversation once the cutover is done (#998): the desk
      // talks to it there, never through the synced row.
      if (row.kind === "dm" && deps.mainLog?.cutover()) return ack({ refused: "main-conversation" });
      if (deps.liveSessions.has(conv) && !deps.liveSessions.canSteer(conv, row.ownerId)) return ack({ refused: "channel-busy" });
      if (deskInFlight >= MAX_DESK_IN_FLIGHT) return ack({ refused: "bot-busy" });
      deskInFlight++;
      try {
        // The echo shows the channel who spoke; it's a platform post, never a history turn.
        let target: { fx: BotEffects; scopeId?: string };
        try {
          target = await effects();
          await target.fx.post(`🖥 (desk): ${text}`);
        } catch (err) {
          console.warn("bean: desk echo failed:", err instanceof Error ? err.name : "error");
          return ack({ refused: "post-failed" });
        }
        const fromName = deps.roles.ownerName;
        const direct = row.kind === "dm";
        const msg: IncomingMessage = {
          conversationId: conv, text, ...owner, fromName, direct,
          ...(direct ? {} : { scopeId: target.scopeId }),
          channelName: direct ? "DM" : row.title,
        };
        // `stop` (typed, or the desk's End) ends the session as the platform command does, never
        // reaching the agent as text. In a conversation that has had a session it is never a Bean
        // turn either — the session may have ended while the echo was in flight. Saved as a line so
        // the desk's pending bubble lands.
        if (commandWord(text) === "stop" && (deps.liveSessions.has(conv) || row.liveCli)) {
          deps.conversations.append(conv, { role: "user", content: speakerLine(fromName, text) });
          ack({ ok: true });
          await onCommand(msg, target.fx);
          return;
        }
        // Re-checked after the echo's await: a session that ended meanwhile takes a normal turn.
        if (deps.liveSessions.has(conv)) {
          deps.conversations.setAmbientCutoff(conv, Date.now());
          return ack(await steerLive(conv, fromName, text) ? { ok: true } : { refused: "queue-full" });
        }
        ack({ ok: true });
        await bot.onMessage(msg, target.fx);
      } finally {
        deskInFlight--;
      }
    },

    async onDeskResume(req, effects, ack): Promise<void> {
      ack(await resumeBoundLive(req.conversationId, async () => (await effects()).fx));
    },

    async onDeskContinue(req, openThread, ack): Promise<void> {
      const catalog = deps.catalog;
      // The owner is the configured one now, never anyone the request names.
      const ownerId = deps.roles.ownerId;
      if (!ownerId) return ack({ refused: "no-owner" });
      if (!catalog) return ack({ refused: "no-record" });
      // Agent mode: the session must be the desktop's, resumable (id shape, folder still there),
      // on a live CLI that's installed here — all checked before any thread exists.
      let run: (DelegateRunRow & { cli: LiveCli }) | undefined;
      if (req.mode === "agent") {
        if (!deps.liveSessionsEnabled() || !deps.recordDelegateRun) return ack({ refused: "unsupported" });
        const found = deps.findDelegateRun?.(req.sessionId, "desktop");
        if (!found || "refusal" in found || !isLiveCli(found.run.cli)) return ack({ refused: "no-record" });
        if (!liveClis().includes(found.run.cli)) return ack({ refused: "cli-missing" });
        run = { ...found.run, cli: found.run.cli };
      }
      let thread: { threadId: string; fx: BotEffects; mention: string };
      try {
        thread = await openThread(ownerId);
      } catch (err) {
        console.warn("bean: desk continue thread failed:", err instanceof Error ? err.name : "error");
        return ack({ refused: "thread-failed" });
      }
      const { threadId, fx, mention } = thread;
      // `run` is always set in agent mode (checked above).
      if (req.mode === "agent") return ack(run ? await moveDeskSession(catalog, run, { threadId, title: req.title, ownerId, fx, mention }) : { partial: true, threadId });
      try {
        catalog.upsert({ conversationId: threadId, place: { kind: "thread", title: req.title }, ownerId });
        deps.conversations.append(threadId, { role: "user", content: formatCarriedBlock(req.tail, req.count) });
        // Neither the title nor the tail goes in the post: the only mention is the owner's.
        await fx.post(`${mention} Continued from Bean desktop · ${req.count} message${req.count === 1 ? "" : "s"} carried over`);
      } catch (err) {
        console.warn("bean: desk continue step failed:", err instanceof Error ? err.name : "error");
        return ack({ partial: true, threadId });
      }
      ack({ ok: true, threadId });
    },

    onAmbient(conversationId, scopeId, fx, line) {
      chimeIn?.onAmbient(conversationId, scopeId, fx);
      channelCapture?.onLine(conversationId, scopeId, line, fx);
      void awayTag(conversationId, line, fx.post);
    },

    onAwayTag: awayTag,

    interruptAwayPrepares: () => awayPrepare?.interrupt(),

    proposeLiveSession(args, fx): Promise<string> {
      return proposeLiveSessionFrom(args.conversationId, args.instruction, args.proposedBy, fx);
    },

    async onMessage(msg: IncomingMessage, fx: BotEffects): Promise<void> {
      // Captured for a session that has since ended or been replaced: not a Bean turn.
      if (msg.liveRun !== undefined && deps.liveSessions.generation(msg.conversationId) !== msg.liveRun) return;
      // Any addressed turn from a run's asker drops Bean's pending follow-up on it (#1133).
      addressed.set(`${msg.conversationId}\n${msg.fromId}`, spoke(msg.conversationId, msg.fromId) + 1);
      // Set once the message reaches converse(); the finally reports the turn's end.
      let turnId: string | undefined;
      let turnFailed = false;
      // DM auto-capture runs beside the rest of the turn; the finally awaits it because Teams'
      // postCard rides this turn's context, which dies when onMessage returns.
      let capture: Promise<void> | undefined;
      // Any addressed message ends the lull wait and drops an in-flight chime-in here.
      chimeIn?.cancel(msg.conversationId);
      // ...but buffered chatter is still worth remembering: extract it now instead of dropping it.
      channelCapture?.flush(msg.conversationId);
      try {
        const cmd = commandWord(msg.text);
        if (deps.liveSessions.has(msg.conversationId)) {
          // Fence this message out of a later ambient replay: fetchRecent's 15-min window is
          // keyed off this same cutoff, so without advancing it here, the next addressed
          // message after the session ends would re-fetch these already-captured messages
          // from Discord history and hand them to converse() a second time.
          deps.conversations.setAmbientCutoff(msg.conversationId, Date.now());
          const conv = msg.conversationId;
          const trimmed = msg.text.trim();
          const lower = trimmed.toLowerCase();
          // Co-driver management — starter only. `+driver @a @b` grants steering; `-driver @a`
          // revokes; `drivers` lists. Mention ids come from the surface (msg.mentionedIds).
          if (deps.liveSessions.isStarter(conv, msg.fromId)) {
            if (lower.startsWith("+driver") || lower.startsWith("-driver")) {
              const grant = lower.startsWith("+driver");
              const ids = msg.mentionedIds ?? [];
              if (ids.length === 0) {
                await fx.reply(`@mention who to ${grant ? "add as a co-driver" : "remove"}, e.g. \`${grant ? "+" : "-"}driver @name\`.`);
                return;
              }
              const changed = ids.filter((id) =>
                grant ? deps.liveSessions.addCoDriver(conv, id) : deps.liveSessions.removeCoDriver(conv, id));
              await fx.reply(changed.length === 0
                ? "No change — already set that way."
                : `${grant ? "Added" : "Removed"} ${changed.length} co-driver(s). Now steering: ${deps.liveSessions.coDrivers(conv).length} co-driver(s) + you.`);
              return;
            }
          }
          // `new` too: a typed reset clears context like Discord's native /new; the session keeps running.
          if (cmd === "stop" || cmd === "drivers" || cmd === "new" || (deps.away && parseAwayCommand(msg.text))) {
            await onCommand(msg, fx);
            return;
          }
          // A start/resume while one runs is never a steer: the owner hears why, anyone else is dropped.
          // Only a slashed `/continue` counts; a bare `continue` is a word the agent may be waiting for.
          if (/^\/?live-session\b|^\/continue$/i.test(trimmed)) {
            if (speakerRole(msg).role === "owner") await fx.reply(liveBusyLine(deps.liveSessions.cli(conv) ?? "claude"));
            return;
          }
          if (!steers(msg)) return;
          const context = liveContext(conv); // before this steer becomes the session's last one
          if (!(await steerLive(conv, msg.fromName, msg.text, msg.images, () => steers(msg)))) {
            await fx.reply(TURN_QUEUE_FULL);
            return;
          }
          // What the owner types to an agent is their own words too (a co-driver's steering is
          // never captured), scoped by where it was typed (#861): a DM saves private like an owner
          // DM turn; a channel or thread saves shared under that channel's memory switch and caps.
          // No receipt card either way — the row shows up in the next digest.
          const steered = msg.typedText ?? msg.text;
          if (speakerRole(msg).role === "owner" && steered.trim()) {
            const transcript: ChatTurn[] = [...context, { role: "user", content: steered, source: "typed" }];
            if (msg.direct) {
              capture = captureDm(
                msg.fromId, [msg.fromId, ...(await deps.ownerSubjectIds?.() ?? [])], transcript, await deps.loadProjects(), undefined, true,
              );
            } else if (msg.scopeId && channelCapture) {
              capture = channelCapture.steer(msg.scopeId, msg.channelName, transcript, await deps.loadProjects());
            }
          }
          return;
        }
        // Typed `stop` with nothing live stays a model turn, as it always was; so does a typed
        // bare `continue` where no live session was ever bound (it's an ordinary word in a chat).
        // In the owner's DM after the cutover (#998) a bare `continue` is always a Bean turn: the main
        // conversation never reopens an agent without a card tap.
        const plainContinue = cmd === "continue" && !msg.text.trim().startsWith("/") &&
          (!deps.catalog?.get(msg.conversationId)?.liveSessionId || historyId(msg.conversationId) === MAIN_CONVERSATION_ID);
        if (cmd !== "stop" && !plainContinue && await onCommand(msg, fx)) return;
        const { role, scopeId } = speakerRole(msg);
        const isOwner = role === "owner";
        if (await dmBlocked(msg, role, fx)) return;
        // The owner's own DM is continuable from the desktop; a member's DM never is.
        if (msg.direct && isOwner) {
          deps.catalog?.upsert({ conversationId: msg.conversationId, place: { kind: "dm", title: "DM" }, ownerId: msg.fromId, ownerAltId: msg.fromAltId });
        }
        // Where this turn's history lives (#998): the main conversation only for the owner in a real
        // 1:1 DM, checked here before any history read; anyone else, and every channel, keeps its own.
        const hid = msg.direct && isOwner ? historyId(msg.conversationId) : msg.conversationId;
        const permitted = permittedFor(role, scopeId, fx);
        turnId = randomUUID();
        deps.onActivity?.({ type: "turn", phase: "start", id: turnId, who: msg.fromName, where: msg.channelName });
        // Guests get Bean's own model and nothing else: no catalog, recall, or todo/delegate tools.
        // Members get recall and todo queues (notes are owner-only) (projects scope those), but no skill catalog.
        const canDelegate = can(role, "delegate");
        const canMemory = can(role, "memory");
        // Recall is scoped before ranking: a channel sees shared facts only; a DM adds the
        // speaker's private ones — for the owner, every id their facts live under, so Discord and
        // Teams DMs share one owner (#647). Writes still store msg.fromId. A fact captured from a
        // channel is recalled in that channel and in the owner's DMs only — never in another
        // channel or a member's DM.
        const recall = !msg.direct ? null
          : isOwner ? [msg.fromId, ...(await deps.ownerSubjectIds?.() ?? [])] : msg.fromId;
        const recallScope = msg.direct ? { allSources: isOwner }
          : msg.scopeId ? { source: `${deps.chatter?.surface ?? ""}:${msg.scopeId}` } : {};
        const [skills, projects, persona, memories, modelMemory, todoRoutines] = await Promise.all([
          canDelegate ? loadActiveSkills() : [],
          canDelegate || canMemory || can(role, "notes") ? deps.loadProjects() : [], deps.loadPersona(),
          canMemory ? deps.loadMemories(recall, recallScope) : [], deps.loadModelMemory(), can(role, "todos") ? deps.listTodoRoutines(!isOwner) : [],
        ]);
        // Owner only: who a routine may DM, and the existing names a draft would replace. A channel
        // sink targets the channel, never the session thread (threads archive).
        const draftable = deps.routines && can(role, "routineDrafts") && isOwner ? draftNames(await deps.routines.load(), new Date()) : undefined;
        const routineAuthoring = deps.routines && can(role, "routineDrafts")
          ? {
              transport: deps.routines.transport,
              // Admins draft new routines only, so they never see (or target) the catalog.
              existing: draftable?.existing ?? [],
              ...(draftable ? { listed: { live: draftable.live, archived: draftable.archived } } : {}),
              recipients: await deps.routines.recipients(),
              ...(msg.direct || !msg.scopeId ? {} : { channelId: msg.scopeId }),
              ...(isOwner && msg.direct === true ? { home: true } : {}),
              cliModels: deps.cliModels,
              ...(deps.routines.destinations ? { destinations: deps.routines.destinations() } : {}),
            }
          : undefined;
        // Owner only, and only where this process runs the scheduler (headless).
        const sprouts = can(role, "runRoutines") ? deps.routines?.sprouts : undefined;
        const sproutRoutines = sprouts && deps.routines ? (await deps.routines.load()).filter((r) => !isArchived(r, new Date())) : [];
        const detected = deps.detectClis();
        // This conversation's task grant, offered to the model only when the speaker holds it.
        const heldGrant = canDelegate ? grants.get(msg.conversationId) : undefined;
        const offered = heldGrant && matchGrant(heldGrant.grant, { surface: grantSurface, scopeKey: msg.conversationId, actorId: msg.fromId }, Date.now()).ok
          ? heldGrant : undefined;
        let history = hid === MAIN_CONVERSATION_ID
          ? await boundMainLog(deps.conversations, { chat: deps.chat, model: deps.model })
          : deps.conversations.history(hid);
        if (fx.fetchRecent) {
          // ponytail: fixed 15-min window; the block carries timestamps so the model can
          // scope "the last 10 minutes" itself — parse the user's timeframe if it matters.
          // The cutoff floor keeps repeat mentions from re-injecting chatter already persisted;
          // it lives in the db so it survives a bot restart alongside the history it guards.
          const now = Date.now();
          const sinceMs = Math.max(now - 15 * 60_000, deps.conversations.ambientCutoff(msg.conversationId));
          const ambient = (await fx.fetchRecent(sinceMs)).slice(-50);
          if (ambient.length > 0) {
            deps.conversations.setAmbientCutoff(msg.conversationId, ambient[ambient.length - 1]!.at + 1);
            const block = formatAmbientBlock(ambient, now);
            // Persist what Bean acted on so follow-up mentions read a coherent history;
            // appended after stored turns because the chatter is newer than they are.
            appendHistory(msg.conversationId, { role: "user", content: block }, hid);
            history = [...history, { role: "user", content: block }];
          }
        }
        // The replied-to message: saved (once) like ambient so follow-ups still see it; an
        // unreadable one gets a hint for this turn's model hops only.
        const repliedHint: typeof history = msg.repliedTo?.unavailable ? [{ role: "user", content: REPLIED_UNAVAILABLE }] : [];
        if (msg.repliedTo && !msg.repliedTo.unavailable) {
          const block = formatRepliedBlock(msg.repliedTo);
          if (!history.some((t) => t.content === block)) {
            appendHistory(msg.conversationId, { role: "user", content: block }, hid);
            history = [...history, { role: "user", content: block }];
          }
        }
        // Per-turn (not shared) so `paths` collects only this request's generated files.
        const imageTool = deps.imageGen && can(role, "images")
          ? makeGenerateImageTool({
              ...deps.imageGen,
              saveNoteImage: deps.saveNoteImage,
              // .catch, not void: a rejected progress post (rate limit, transient network)
              // fires outside onMessage's try — unhandled, it kills the whole bot process.
              onStart: () => { fx.post("🎨 Working on your image — this can take a minute…").catch(() => {}); },
            })
          : undefined;
        // The msg.text is what this person typed, so it's the one citable source for remember;
        // the chat-skill follow-up below reuses converseBase without these tools.
        const typed = msg.typedText ?? msg.text;
        const scope = saveScope(typed, msg.direct);
        // Owner paths categorize (#648): the owner's DM only — a member's and any channel don't.
        const ownerDm = isOwner && msg.direct;
        // Sending by name: the owner's real DM only — never a shared chat, a member's DM or a targeted pick.
        const sendHere = ownerDm && deps.send !== undefined && deps.cards.sendCard !== undefined;
        const memoryTools = makeMemoryTools({
          append: deps.appendMemories, forget: (ids) => deps.deleteMemories(ids, isOwner ? undefined : msg.fromId),
          memories, projects, latestUserText: typed, ...(scope === "private" ? { subjectId: msg.fromId } : {}),
          categorize: ownerDm,
          classifier: { chat: deps.chat, model: deps.model },
        });
        // Delivery goes where it was asked: a Discord DM → this speaker's DM, anything else
        // (every Teams conversation, a Discord channel) → this conversation's full ingress id.
        const reminderTools = deps.reminders && can(role, "reminders")
          ? makeReminderTools({
              file: deps.reminders.file,
              target: deps.reminders.transport === "teams"
                ? { transport: "teams", channelId: msg.conversationId }
                : msg.direct ? { transport: "discord", userId: msg.fromId } : { transport: "discord", channelId: msg.conversationId },
              setBy: msg.fromId, isOwner, direct: msg.direct, conversationId: msg.conversationId,
            })
          : undefined;
        const todoTools = can(role, "todos")
          ? makeTodoTools({ list: deps.listOpenTodos, cancel: deps.cancelTodo, speakerId: msg.fromId, isOwner })
          : [];
        // background_work (#924): same gate as list_todos. The owner sees everything; anyone else
        // only their own todos and jobs — and a member's DM has no dispatch rows of theirs at all
        // (an unset conversation is the owner's DM).
        const work = deps.backgroundWork;
        if (work && can(role, "todos")) {
          const conversation = msg.direct ? undefined : msg.conversationId;
          const running = deps.routines?.sprouts?.running;
          todoTools.push(makeBackgroundWorkTool({
            file: work.file, stateFile: work.stateFile,
            dispatches: () => (msg.direct && !isOwner ? [] : work.dispatches(conversation)),
            ...(isOwner ? (running ? { running } : {}) : { viewer: msg.fromId }),
          }));
        }
        // runAvailable=false: propose_run is never offered here — confirming one couldn't
        // execute anything from Teams/Discord; propose_delegate is the only run path.
        // The tool list is built from the role (action tools run inside converse(), so leaving
        // them out is their gate); proposals are re-checked against the role below.
        // read_sprout / read_skill / run_history: owner only — step instructions and skill bodies are theirs.
        const readTools = isOwner && work && deps.routines
          ? makeSproutReadTools({ routines: deps.routines.load, skills: deps.loadSkills, stateFile: work.stateFile, dbFile: work.file })
          : [];
        const actions = [
          ...(can(role, "notes") ? [noteTool] : []), ...(can(role, "systemControl") ? [systemTool] : []),
          ...(imageTool ? [imageTool.tool] : []), ...readTools,
        ];
        const converseBase = {
          skills, projects, persona, memories,
          deps: { chat: deps.chat, model: deps.model, rankByMeaning: deps.rankByMeaning },
          actions,
          delegateAvailable: canDelegate,
          scratchPath: canDelegate ? deps.scratchPath : undefined,
          liveSessionAvailable: can(role, "liveSession") && liveClis().length > 0,
          noteAvailable: can(role, "notes"),
          noteArchiveAvailable: can(role, "notes"),
          skillAuthoringAvailable: can(role, "skillWrites"),
          roleNote: roleLine(role, deps.roles, scopeId),
          availableClis: detected,
          models: availableModels(deps.cliModels, detected),
          runAvailable: false,
          todoRoutines,
          webSearch: deps.webSearchEnabled?.() ?? false,
          speaker: msg.fromName,
          pinOwnerMemories: ownerDm, // #650: the owner's DM only — never a channel or a member
          routineAuthoring,
          sendAvailable: sendHere,
        };
        const result = await converse({
          ...converseBase,
          actions: [...converseBase.actions, ...(canMemory ? memoryTools.tools : []), ...(reminderTools?.tools ?? []), ...todoTools],
          sproutCatalog: sproutRoutines.map((r) => ({ name: r.name, description: r.description, takesTask: r.todoDriven })),
          history: [...history, ...repliedHint], latestUserText: msg.text, latestUserImages: msg.images,
          ...(ownerDm && canMemory ? { memoryCategories: memoryCategories(memories) } : {}),
          ...(offered ? { activeSession: {
            cli: offered.grant.cli, projectPath: offered.grant.projectPath, lastInstruction: offered.instruction,
            projectName: delegateProjectLabel(offered.grant.projectPath, projects),
          } } : {}),
        });
        turnFailed = result.error !== undefined;
        // History keeps only "[image attached]"; the bytes stay in bounded memory for a
        // follow-up "save that to a note". Before any proposal is added so the cap's
        // oldest-first eviction drops this slot, not the new proposal holding the same images.
        if (deps.saveNoteImage && msg.images?.length) deps.noteProposals.rememberImages(msg.conversationId, msg.images);
        appendHistory(msg.conversationId, {
          role: "user",
          content: speakerLine(msg.fromName, msg.images?.length ? `${msg.text}\n[image attached]` : msg.text),
        }, hid);
        // A chat-target run answers in-line here, with no card for converse()'s lead-in to introduce.
        const reply = result.proposedRun?.target === "chat" && result.reply === CARD_LEAD ? "" : result.reply;
        if (reply) {
          appendHistory(msg.conversationId, { role: "assistant", content: reply }, hid);
          // The owner talking to Bean while away here: a reminder, kept out of history.
          await fx.reply(isOwner && deps.away?.get().on ? `${reply}\n\n${awayReminder(deps.away)}` : reply);
        }
        // Drains (splices) the collector so a later pass — the chat-target follow-up below
        // shares this same tool instance — never re-sends already-delivered images.
        const deliverImages = async (): Promise<void> => {
          for (const p of imageTool?.paths.splice(0) ?? []) {
            if (fx.sendFile) await fx.sendFile(p);
            else await fx.post(`(image saved to ${p} — this surface can't display it)`);
          }
        };
        await deliverImages();
        if (memoryTools.remembered.length > 0) {
          const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
          for (const m of memoryTools.remembered) {
            await fx.postCard(deps.cards.rememberedCard({
              memoryId: m.id, text: m.text, projectName: m.projectPath ? nameFor(m.projectPath) : undefined, category: m.category, scope,
            }));
          }
        }
        // Only the speaker's typed words are citable (never an audio transcript); a turn that
        // already remembered or forgot something explicitly is left alone.
        if (msg.direct && canMemory && !turnFailed && typed.trim() && memoryTools.remembered.length === 0 && memoryTools.forgotten.length === 0) {
          capture = captureDm(msg.fromId, recall ?? msg.fromId, [...history, { role: "user", content: typed, source: "typed" }], projects, fx, ownerDm);
        }
        for (const r of reminderTools?.set ?? []) {
          if (deps.cards.reminderCard) await fx.postCard(deps.cards.reminderCard({ reminderId: r.id, text: r.text, at: r.at }));
        }
        // The main log is bounded before each turn instead (boundMainLog), on every surface.
        if (hid !== MAIN_CONVERSATION_ID) void maybeCompact(hid, deps.conversations, { chat: deps.chat, model: deps.model });
        if (result.proposedRun) {
          // A `target: chat` skill runs on Bean's own model: resend the composed prompt
          // through this same conversation (mirrors ChatWindow's confirmProposal). No
          // confirm card — it's just another chat reply, no agent harness or side effects.
          if (result.proposedRun.target === "chat") {
            if (!(await permitted("runSkills", "run skills"))) return;
            const run = result.proposedRun;
            const followup = await converse({
              ...converseBase,
              history: [...deps.conversations.history(hid), ...repliedHint],
              latestUserText: run.composedPrompt,
            });
            appendHistory(msg.conversationId, { role: "user", content: speakerLine(msg.fromName, run.composedPrompt) }, hid);
            // Nested proposals from the skill prompt are deliberately ignored — one hop only —
            // except a send card, under the same owner-DM gate as the first hop.
            const sendCard = sendHere ? followup.proposedSend : undefined;
            // A pure tool-use second hop leaves reply empty; never answer with silence.
            // An ignored nested card's lead-in is no answer either.
            const text = (sendCard || followup.reply !== CARD_LEAD ? followup.reply.trim() : "") ||
              (sendCard ? "" : `The ${run.skillName} skill didn't produce a reply — try asking me directly instead.`);
            if (text) {
              appendHistory(msg.conversationId, { role: "assistant", content: text }, hid);
              // reply, not post: this is the turn's answer, so surface extras (Discord voice
              // replies) apply to it too.
              await fx.reply(text);
            }
            await deliverImages(); // the follow-up hop can call generate_image too
            if (sendCard) await postSendCard(sendCard, msg, fx);
            return;
          }
          // Backstop only: terminal-target propose_run isn't offered from chatops, so this
          // can't fire from a well-behaved model — but if it does, point at what works.
          await fx.post(DESKTOP_ONLY);
          return;
        }
        if (result.proposedSend) {
          // Backstop: converse() already refuses an un-offered tool.
          if (!sendHere) return;
          await postSendCard(result.proposedSend, msg, fx);
          return;
        }
        if (result.proposedLiveSession) {
          if (!(await permitted("liveSession", "start a live session"))) return;
          await postLiveSessionProposal(result.proposedLiveSession, msg.conversationId, msg.fromName, fx);
          return;
        }
        if (result.proposedNote) {
          if (!(await permitted("notes", "save notes"))) return;
          const note = result.proposedNote;
          const projectName = note.project
            ? (projects.find((p) => p.path === note.project)?.name ?? note.project)
            : undefined;
          // This turn's images, else the conversation's recent slot ("save that image" as a
          // follow-up). Refs are appended by code on Save, bound to the stored ids.
          const images = deps.saveNoteImage
            ? (msg.images?.length ? msg.images : deps.noteProposals.recentImages(msg.conversationId))
            : undefined;
          const pending = deps.noteProposals.add({
            note, conversationId: msg.conversationId, proposedBy: msg.fromName, images,
          });
          const activityId = await fx.postCard(deps.cards.noteProposalCard({
            proposalId: pending.id, title: note.title, body: note.body, projectName, updating: note.slug !== undefined,
            imageCount: images?.length,
          }));
          deps.noteProposals.setCardActivityId(pending.id, activityId);
          recordCard(msg.conversationId, "note", "pending");
          return;
        }
        if (result.proposedNoteArchive) {
          if (!(await permitted("notes", "archive notes"))) return;
          const { query } = result.proposedNoteArchive;
          const note = (await deps.searchNotes(query))[0];
          if (!note) {
            await fx.post(`I couldn't find a note matching "${query}".`);
            return;
          }
          const pending = deps.noteArchiveProposals.add({
            slug: note.slug, title: note.title, conversationId: msg.conversationId, proposedBy: msg.fromName,
          });
          const activityId = await fx.postCard(deps.cards.noteArchiveProposalCard({
            proposalId: pending.id, title: note.title, updated: note.updated,
            projectName: note.project ? (projects.find((p) => p.path === note.project)?.name ?? note.project) : undefined,
            // First non-blank, non-heading line (note bodies open with "## Summary").
            snippet: (note.body.split("\n").find((l) => l.trim() && !l.trimStart().startsWith("#")) ?? "").trim().slice(0, 200),
          }));
          deps.noteArchiveProposals.setCardActivityId(pending.id, activityId);
          recordCard(msg.conversationId, "note archive", "pending");
          return;
        }
        if (result.proposedSkill) {
          if (!(await permitted("skillWrites", "save skills"))) return;
          const skill = result.proposedSkill;
          const pending = deps.skillProposals.add({ skill, conversationId: msg.conversationId, proposedBy: msg.fromName });
          // Every skill (built-ins and disabled ones too): a replacement overrides whichever exists.
          const existing = (await deps.loadSkills()).find((s) => s.name === skill.name);
          const browser = skillBrowserChange(skill.body, existing?.browser === true);
          const activityId = await fx.postCard(deps.cards.skillProposalCard({
            proposalId: pending.id, name: skill.name, body: skill.body, updating: skill.updating,
            ...(browser ? { browser } : {}),
          }));
          deps.skillProposals.setCardActivityId(pending.id, activityId);
          recordCard(msg.conversationId, "skill", "pending", skill.name);
          return;
        }
        if (result.proposedSproutRun) {
          if (!(await permitted("runRoutines", "run sprouts")) || !sprouts) return;
          const name = result.proposedSproutRun.routine;
          const routine = sproutRoutines.find((r) => r.name === name);
          if (!routine) return; // converse already refused names outside the catalog
          const { pending, seeded } = await sprouts.facts(routine);
          const out = planSproutRun(routine, pending, seeded, homeDestination(persona.name, await deps.routines?.homeDms?.()));
          if ("blocked" in out) {
            await fx.post(SPROUT_BLOCKED[out.blocked](name));
            return;
          }
          const p = sprouts.proposals.add({
            plan: out.plan, conversationId: msg.conversationId, proposedById: msg.fromId,
            ...(msg.direct ? {} : { channel: msg.conversationId }),
          });
          const activityId = await fx.postCard(deps.cards.sproutRunCard({ proposalId: p.id, plan: out.plan }));
          sprouts.proposals.setCardActivityId(p.id, activityId);
          recordCard(msg.conversationId, "sprout", "pending", out.plan.routine);
          return;
        }
        if (result.proposedTodo) {
          if (!(await permitted("todos", "queue tasks"))) return;
          const todo = result.proposedTodo;
          // Reported back where it was asked (#923) — except a member's DM: only the owner's DM is
          // a known destination.
          const report = isOwner || !msg.direct ? (msg.direct ? {} : { channel: msg.conversationId }) : undefined;
          const pending = deps.todoProposals.add({
            todo, conversationId: msg.conversationId, proposedBy: msg.fromName, requesterId: msg.fromId, member: !isOwner,
            ...(report && deps.queueTodoDispatch ? { report } : {}),
          });
          const ahead = await deps.pendingTodos?.(todo.routine).catch(() => undefined);
          const runNow = isOwner && deps.queueTodoDispatch !== undefined && can(role, "runRoutines") && deps.routines?.sprouts !== undefined;
          const activityId = await fx.postCard(deps.cards.todoProposalCard({
            proposalId: pending.id, routine: todo.routine, text: todo.text,
            ...(ahead !== undefined ? { ahead } : {}), ...(runNow ? { runNow: true } : {}),
          }));
          deps.todoProposals.setCardActivityId(pending.id, activityId);
          recordCard(msg.conversationId, "todo", "pending", todo.routine);
          return;
        }
        if (result.proposedRoutine) {
          if (!(await permitted("routineDrafts", "set up sprouts"))) return;
          if (!deps.routines || !deps.cards.routineProposalCard) return;
          let proposal = result.proposedRoutine;
          // An invalid draft can be any shape; its card offers no Save.
          if (!proposal.problem) proposal = { ...proposal, routine: draftHome(proposal.routine, isOwner && msg.direct === true) };
          if (!isOwner && !proposal.problem) {
            // An admin's draft starts off, and a name clash is shown up front ("Can't save").
            const name = String(proposal.routine.name);
            const taken = (await deps.routines.load()).some((x) => x.name.toLowerCase() === name.toLowerCase());
            proposal = { ...proposal, routine: { ...proposal.routine, enabled: false }, ...(taken ? { problem: nameTaken(name) } : {}) };
          }
          const target = isOwner ? (await deps.routines.load()).find((x) => x.name === String(proposal.routine.name)) : undefined;
          const pending = deps.routines.proposals.add({
            ...(target ? { prior: JSON.stringify(target) } : {}),
            proposal, conversationId: msg.conversationId, proposedBy: msg.fromName,
            proposedById: msg.fromId, byOwner: isOwner, ...(msg.channelName ? { where: msg.channelName } : {}),
            home: homeDestination(persona.name, await deps.routines.homeDms?.()),
            ...(routineAuthoring?.channelId ? { channelId: routineAuthoring.channelId } : {}),
          });
          const activityId = await fx.postCard(deps.cards.routineProposalCard(
            routineCardInput(pending, routineAuthoring?.recipients ?? [], deps.roles.ownerName),
          ));
          deps.routines.proposals.setCardActivityId(pending.id, activityId);
          recordCard(msg.conversationId, "sprout draft", "pending", String(proposal.routine.name));
          return;
        }
        let proposal = result.proposedDelegate;
        if (!proposal) return;
        if (!(await permitted("delegate", "run tasks"))) return;
        // A follow-up to the granted task: continued at once, or the normal card with the reason —
        // and that card starts fresh, never silently on the earlier session.
        let fresh = false;
        if (proposal.continue) {
          const { continue: _c, ...plain } = proposal;
          const why = offered ? await continueTask(msg, plain, offered.grant, detected, skills, fx) : GRANT_MISMATCH_TEXT.none;
          if (why === undefined) return;
          await fx.post(why);
          proposal = plain;
          fresh = true;
        } else if (heldGrant && !offered && heldGrant.grant.actorId === msg.fromId) {
          // The speaker's own grant lapsed (30 idle minutes, /new): say why this one needs a card.
          const lapsed = matchGrant(heldGrant.grant, { surface: grantSurface, scopeKey: msg.conversationId, actorId: msg.fromId }, Date.now());
          if (!lapsed.ok) {
            await fx.post(GRANT_MISMATCH_TEXT[lapsed.reason]);
            fresh = true; // like any fallback card: never onto the lapsed session's thread pointer
          }
        }
        const choice = resolveCliModel(detected, { cli: proposal.cli, model: proposal.model }, modelMemory, deps.cliModels);
        if (!choice) {
          await fx.post(NO_CLI);
          return;
        }
        const pending = deps.proposals.add({
          proposal, conversationId: msg.conversationId, proposedBy: msg.fromName,
          defaultCli: choice.cli, defaultModel: choice.model, ...(fresh ? { fresh: true as const } : {}),
        });
        const activityId = await fx.postCard(deps.cards.proposalCard({
          proposalId: pending.id, skillName: proposal.skillName,
          projectPath: proposal.projectPath === deps.scratchPath ? "__none__" : proposal.projectPath,
          projects: projects.map((p) => ({ name: p.name, path: p.path })), scratch: deps.scratchPath !== undefined,
          instruction: proposal.instruction, clis: detected,
          skills: skills.filter((s) => !s.hidden).map((s) => ({ name: s.name, ...(s.browser ? { browser: true } : {}) })),
          models: availableModels(deps.cliModels, detected), defaultCli: choice.cli, defaultModel: choice.model,
        }));
        deps.proposals.setCardActivityId(pending.id, activityId);
        recordCard(msg.conversationId, "delegate", "pending", proposal.skillName);
      } catch (err) {
        turnFailed = true;
        await fx.reply(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (turnId) deps.onActivity?.({ type: "turn", phase: "end", id: turnId, who: msg.fromName, where: msg.channelName, failed: turnFailed });
        await capture;
      }
    },

    async onCardAction(action: CardAction, fx: BotEffects): Promise<void> {
      const { beanAction, proposalId, projectPath, runId } = action.value;
      // When the tap arrived: a `/new` during the awaits before a confirmed run launches still counts.
      const resetsAtTap = resets.get(action.conversationId) ?? 0;
      // Checked before any claim(), so a refused tap leaves the card usable for someone who may.
      const role = deps.roles.roleOf({ fromId: action.fromId, fromAltId: action.fromAltId, scopeId: action.scopeId });
      const need = cardActionNeeds(beanAction);
      if (!atLeast(role, need)) {
        if (firstRefusal(`card:${action.fromId}:${proposalId ?? runId ?? projectPath ?? beanAction}`)) {
          await fx.post(cardTapRefusal(need, role, deps.roles));
        }
        return;
      }
      if (beanAction === "cancel-run") {
        // An admin cancels only runs started from this conversation; the owner, any run.
        const scope = role === "owner" ? undefined : action.conversationId;
        // A card from before runs were keyed by id has no runId; its run is long gone.
        if (!runId || !deps.runs.cancel(runId, scope)) {
          await fx.post(runId && scope ? "That run wasn't started from this conversation, or it already finished." : "That run is no longer running.");
        }
        return;
      }
      if (beanAction === "save-note" || beanAction === "cancel-note") {
        await handleNoteAction(beanAction, proposalId, action.fromName, action.conversationId, fx);
        return;
      }
      if (beanAction === "archive-note" || beanAction === "cancel-archive-note") {
        await handleNoteArchiveAction(beanAction, proposalId, action.fromName, action.conversationId, fx);
        return;
      }
      if (beanAction === "restore-note") {
        // proposalId carries the note id here (the surfaces' generic id slot).
        await handleRestoreNote(proposalId, action.fromName, fx);
        return;
      }
      if (beanAction === "save-skill" || beanAction === "cancel-skill") {
        await handleSkillAction(beanAction, proposalId, action.fromName, action.conversationId, fx);
        return;
      }
      if (beanAction === "save-routine" || beanAction === "cancel-routine" || beanAction === "toggle-routine") {
        await handleRoutineAction(beanAction, proposalId, action, role, fx);
        return;
      }
      if (beanAction === "run-sprout" || beanAction === "cancel-sprout") {
        await handleSproutAction(beanAction, proposalId, action, fx);
        return;
      }
      if (beanAction === "send-confirm" || beanAction === "send-cancel" || beanAction === "send-pick") {
        await handleSendAction(beanAction, action, fx);
        return;
      }
      if (beanAction === "run-todo" || beanAction === "queue-todo" || beanAction === "cancel-todo") {
        await handleTodoAction(beanAction, proposalId, action, role === "owner", fx);
        return;
      }
      if (beanAction === "forget-memory") {
        // proposalId carries the memory id here (the surfaces' generic id slot).
        await handleForget(proposalId, action.fromName, role === "owner" ? undefined : action.fromId, fx);
        return;
      }
      if (beanAction === "share-memory") {
        // proposalId carries the memory id here (the surfaces' generic id slot).
        await handleShare(proposalId, action.fromName, action.fromId, fx);
        return;
      }
      if (beanAction === "cancel-reminder") {
        // proposalId carries the reminder id here (the surfaces' generic id slot).
        await handleCancelReminder(proposalId, action.fromName, action.fromId, action.conversationId, role === "owner" ? undefined : action.fromId, fx);
        return;
      }
      if (beanAction === "resume-live") {
        // proposalId carries the CLI session id here (the surfaces' generic id slot).
        const refusal = await proposeResumeLive(action.conversationId, proposalId ?? "", action.fromName, fx);
        if (refusal) await fx.post(refusal);
        return;
      }
      if (beanAction === "start-live" || beanAction === "cancel-live") {
        if (!proposalId) return;
        // Same conversation binding as delegate cards below: live ids are sequential too.
        const peek = deps.liveSessionProposals.get(proposalId);
        if (peek && peek.conversationId !== action.conversationId) {
          await fx.post("That proposal belongs to another conversation.");
          return;
        }
        const v = action.value;
        // Refused before the claim, so the card stays live for picking another skill or CLI.
        if (beanAction === "start-live" && peek) {
          const { refusal } = await liveSkill(liveCliOf(peek.proposal, v), liveSkillNameOf(peek.proposal, v));
          if (refusal) {
            await fx.post(refusal);
            return;
          }
          // Effective path: Teams submits it, Discord already wrote its select into the proposal.
          if (!peek.proposal.resume && !(await registeredProject(v.projectPath || peek.proposal.projectPath))) {
            await fx.post("That project isn't registered any more — pick another and press Start again.");
            return;
          }
        }
        const pending = deps.liveSessionProposals.claim(proposalId);
        if (!pending) {
          recordExpired(peek, action.conversationId, "live session");
          await fx.post("That live-session proposal expired — ask me to start one again.");
          return;
        }
        if (beanAction === "cancel-live") {
          recordCard(pending.conversationId, "live session", "cancelled");
          const projectName = await projectLabel(pending.proposal.projectPath, !!pending.proposal.resume);
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled", ...shownPrompt(pending.proposal) }));
          }
          return;
        }
        // The proposal was only offered while live sessions were enabled, but it can sit
        // unclaimed for up to 10 minutes — re-check the gate here, the one place that
        // actually launches the permissions-bypassed process.
        if (!deps.liveSessionsEnabled()) {
          recordCard(pending.conversationId, "live session", "didn't start");
          const projectName = await projectLabel(pending.proposal.projectPath, !!pending.proposal.resume);
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled", ...shownPrompt(pending.proposal) }));
          }
          await fx.post("Live sessions are disabled — this session wasn't started.");
          return;
        }
        // On-card selections. Teams merges its ChoiceSet/Input values into the Start submit;
        // Discord already applied them live via per-select updates, so its value omits these
        // (each guard is a no-op when the field is absent).
        // A resumed session's project is locked to its recorded row (startLiveSessionAction).
        if (v.projectPath && !pending.proposal.resume) pending.proposal.projectPath = v.projectPath;
        // Same lock for the CLI; an unknown value is ignored (Start re-checks detection).
        if (isLiveCli(v.cli) && !pending.proposal.resume) pending.proposal.cli = v.cli;
        const liveText = typeof v.instruction === "string" ? v.instruction.trim() : "";
        if (liveText) pending.proposal.instruction = liveText;
        if (v.model !== undefined) pending.proposal.model = v.model || undefined;
        pending.proposal.skillName = liveSkillNameOf(pending.proposal, v);
        if (v.steering === "open" || v.steering === "restricted") pending.proposal.steering = v.steering;
        await startLiveSessionAction(pending, action.fromName, action.fromId, fx,
          role === "owner" && action.place ? { altId: action.fromAltId, place: action.place } : undefined);
        return;
      }
      if (!proposalId) return;
      if (beanAction !== "cancel-proposal" && beanAction !== "confirm") return;
      // Bind the card to its conversation before claiming: ids are sequential, so a forged
      // submit from another conversation could otherwise launch (or inject text into) a
      // proposal whose run resumes this thread's agent session. Refused without consuming it.
      const held = deps.proposals.peek(proposalId);
      const peek = deps.proposals.get(proposalId);
      if (peek && peek.conversationId !== action.conversationId) {
        await fx.post("That proposal belongs to another conversation.");
        return;
      }
      // Edited instruction (Teams' Input.Text merges it into the Run submit). Client-supplied:
      // trim, blank keeps the proposal's text, over-cap is rejected before claim so the card
      // stays usable.
      const edited = beanAction === "confirm" && typeof action.value.instruction === "string"
        ? action.value.instruction.trim()
        : "";
      if (edited.length > MAX_INSTRUCTION_CHARS) {
        await fx.post(`That prompt is too long (${edited.length} chars, max ${MAX_INSTRUCTION_CHARS}) — shorten it and press Run again.`);
        return;
      }
      // On-card project pick. Client-supplied (a forged Teams submit or Discord select value), so
      // only a registered project or `__none__` (this bot's own scratch workspace) is accepted;
      // refused before claim so the card stays usable. Absent = keep the proposal's project.
      const pickedProject = beanAction === "confirm" ? action.value.projectPath : undefined;
      let projectPick: string | undefined;
      if (pickedProject) {
        projectPick = pickedProject === "__none__"
          ? deps.scratchPath
          : (await deps.loadProjects()).find((pr) => pr.path === pickedProject)?.path;
        if (!projectPick) {
          await fx.post("That project isn't registered any more — pick another and press Run again.");
          return;
        }
      }
      const p = deps.proposals.claim(proposalId);
      if (beanAction === "cancel-proposal") {
        if (p) recordCard(p.conversationId, "delegate", "cancelled", p.proposal.skillName);
        if (p?.cardActivityId !== undefined) {
          const projectName = delegateProjectLabel(p.proposal.projectPath, await deps.loadProjects());
          await fx.updateCard(p.cardActivityId, deps.cards.finishedCard({
            projectName, instruction: p.proposal.instruction, startedBy: action.fromName, outcome: "cancelled",
          }));
        }
        return;
      }
      // beanAction === "confirm" (the only value the line-158 guard lets fall through here)
      if (!p) {
        recordExpired(held, action.conversationId, "delegate");
        await fx.post("That proposal expired — ask me again.");
        return;
      }
      // On-card skill pick (same sentinel as the live-session card). Teams merges its
      // ChoiceSet value into the Run submit; Discord applies it from its per-message selections.
      if (edited) p.proposal = { ...p.proposal, instruction: edited };
      if (projectPick) p.proposal = { ...p.proposal, projectPath: projectPick };
      const picked = action.value.skillName;
      if (picked !== undefined) p.proposal.skillName = picked === "__none__" ? undefined : (picked || undefined);
      const detected = deps.detectClis();
      const memory = await deps.loadModelMemory();
      const choice = resolveCliModel(
        detected,
        { cli: action.value.cli as CliName | undefined, model: action.value.model },
        memory,
        deps.cliModels,
      );
      if (!choice) {
        recordCard(p.conversationId, "delegate", "didn't start"); // the picked skill isn't resolved yet
        await fx.post(NO_CLI);
        return;
      }
      await startRun(p, choice.cli, choice.model, action.fromName, fx, { actorId: action.fromId, resets: resetsAtTap }, undefined, {
        id: action.fromId, ...(action.fromAltId ? { altId: action.fromAltId } : {}),
        ...(action.scopeId ? { scopeId: action.scopeId } : {}), name: action.fromName,
      });
    },
  };
  return bot;
}
