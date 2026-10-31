import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ChatopsActivitySink } from "./activity.js";
import { converse, speakerLine, type ChatTurn, type ConverseDeps, type ImageAttachment, type ProposedLiveSession } from "../converse.js";
import { makeGenerateImageTool, type ImageGenDeps } from "../image-gen.js";
import { composePrompt } from "../prompt.js";
import { makeMemoryTools, saveScope } from "../memory/tools.js";
import { extractMemories } from "../memory/extract.js";
import { makeReminderTools, reminderInConversation } from "./reminder-tools.js";
import { makeTodoTools } from "./todo-tools.js";
import { chatRoutineProblem, todoRunHint, type Routine } from "../routine-store.js";
import type { TodoItem } from "../todo-store.js";
import { cancelReminder } from "../reminders.js";
import { availableModels } from "../models.js";
import type { Skill, Project } from "../types.js";
import type { Persona } from "../persona.js";
import type { Memory } from "../memory/memory.js";
import type { CliName } from "../launcher.js";
import type { CliModels } from "../cli-models.js";
import { OPENCODE_BROWSER_REFUSAL, type DelegateRequest } from "../delegate.js";
import { BAD_SESSION_ID, isLiveSessionId, isValidSessionId, resumeCommand, type ResumableRun } from "../delegate-runs.js";
import { LIVE_CLIS, isLiveCli, type LiveCli } from "../live-session.js";
import { TURN_QUEUE_FULL } from "../turn-live-session.js";
import type { CardBuilders } from "./cards-api.js";
import { formatAmbientBlock, formatRepliedBlock, REPLIED_UNAVAILABLE, type AmbientMessage, type RepliedMessage } from "./ambient.js";
import { memoryUpdatesFor, resolveCliModel } from "./resolve.js";
import type { ConversationStore } from "./conversation.js";
import type { ConversationCatalog, ConversationPlace } from "./catalog.js";
import { MAX_DESK_TEXT, type DeskAckResult, type DeskRefusal } from "./desk.js";
import { maybeCompact } from "./compact.js";
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
import type { RunRegistry } from "./runs.js";
import { LiveSessionProposalStore, type PendingLiveSession } from "./live-session-proposals.js";
import { LiveSessionRegistry, type LiveSessionSink } from "./live-sessions.js";
import {
  atLeast, can, cardActionNeeds, cardTapRefusal, dmAllowed, dmRefusal, needs, parseRoleCommand, refusal, roleLine,
  routineAdminRefusal, routineDraftRefusal,
  type Capability, type Role, type Roles,
} from "./roles.js";
import { makeAmbientCapture, type AmbientLine } from "./ambient-capture.js";
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
  value: { beanAction?: string; proposalId?: string; projectPath?: string; runId?: string; cli?: string; model?: string; skillName?: string; steering?: string; instruction?: string };
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
  loadSkills: () => Promise<Skill[]>;
  loadProjects: () => Promise<Project[]>;
  loadPersona: () => Promise<Persona>;
  /** Scoped like core's loadMemories: absent = all, `null` = household-shared only, an id =
   * shared plus that speaker's private facts. */
  loadMemories: (subject?: string | null) => Promise<Memory[]>;
  loadModelMemory: () => Promise<Record<string, string>>;
  saveModelMemory: (m: Record<string, string>) => Promise<void>;
  detectClis: () => CliName[];
  cliModels: CliModels[]; // loaded once at boot from clis.json (repo default + ~/.bean override)
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
  /** Names of routines with todoDriven=true — gates the propose_todo tool. `member` = only
   * `memberTodoEligible` ones (no delegate or command steps). */
  listTodoRoutines: (member: boolean) => Promise<string[]>;
  /** Backs list_todos / cancel_todo: `createdBy` set = only that speaker's rows (SQL-filtered). */
  listOpenTodos: (createdBy?: string) => Promise<TodoItem[]>;
  cancelTodo: (id: string, createdBy?: string) => Promise<boolean>;
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
  cards: CardBuilders;
  /** Gates the system_control action tool, same as main.ts's desktop wiring. */
  systemControlsEnabled: () => boolean;
  /** Config `webSearch`: offer converse() the built-in public web search. */
  webSearchEnabled?: () => boolean;
  /** Active chat-bridged agent sessions; while a channel is bound, its messages bypass converse. */
  liveSessions: LiveSessionRegistry;
  liveSessionProposals: LiveSessionProposalStore;
  /** Gates the propose_live_session tool (surface support, e.g. a live-capable CLI is present). */
  liveSessionsEnabled: () => boolean;
  /** delegate_runs lookup behind Continue live (server injects the db path). Omit = no record. */
  findDelegateRun?: (sessionId: string) => ResumableRun;
  /** Working dir for delegates not tied to a project (must exist); omit to require a project. */
  scratchPath?: string;
  /** Enables the generate_image action tool; omit to disable image generation. */
  imageGen?: Pick<ImageGenDeps, "generate" | "model" | "imagesDir">;
  /** Bean's turns (converse path only) for the desktop app's status bubbles (see activity.ts). */
  onActivity?: ChatopsActivitySink;
  /** Enables the chatops reminder tools (member+): reminders.json path plus this surface's
   * outbox transport. Teams targets are always the asking conversation (its outbox can't DM
   * a specific user); Discord DMs target the speaker. */
  reminders?: { file: string; transport: "discord" | "teams" };
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
  routines?: {
    transport: "discord" | "teams";
    load: () => Promise<Routine[]>;
    save: (routine: Routine) => Promise<void>;
    create: (routine: Routine) => Promise<void>;
    notifyOwner: (text: string) => Promise<void>;
    recipients: () => Promise<{ id: string; name: string }[]>;
    proposals: RoutineProposalStore;
  };
}

const nameTaken = (name: string): string => `a sprout named "${name}" already exists — ask for a different name.`;

const DESKTOP_ONLY =
  "That needs the Bean desktop app — from here I can only chat and run background delegate tasks. Ask me again and I'll run it as one.";
const NO_CLI = "I can't run delegate tasks: no supported CLI (`claude`, `opencode`, or `codex`) is available on this machine.";

/** The session id in `/live-session resume <rest>`. Pasted `claude --resume <id>`,
 * `codex resume <id>` and `opencode -s <id>` / `--session <id>` spans win (also inside a routine
 * digest's footer line), all merged before the one-id check; otherwise every valid-looking token
 * counts, and exactly one is required. */
export function parseResumeArg(rest: string): { id: string } | { error: string } {
  const flagged = [...rest.matchAll(/(?:\bresume|(?<![^\s`])(?:-s|--session))\s+`?([^\s`]+)/g)].map((m) => m[1] ?? "");
  const candidates = flagged.length > 0 ? flagged : rest.replace(/`/g, " ").split(/\s+/);
  const ids = [...new Set(candidates.filter(isValidSessionId))];
  if (ids.length === 0) return { error: BAD_SESSION_ID };
  if (ids.length > 1) return { error: "Send just one session id." };
  return { id: ids[0]! };
}

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
} {
  const chimeIn = deps.chatter && makeChimeIn({
    chatter: deps.chatter, chat: deps.chat, model: deps.model,
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

  // DM auto-capture (#462): after the reply, the latest typed turn's facts are saved private to
  // the speaker, each with the usual Forget/Share receipt. Captures run one at a time so each
  // sees what the last one saved; never rejects. ponytail: one chain for every DM; per-speaker
  // chains if capture latency ever queues up.
  let captureChain: Promise<void> = Promise.resolve();
  function captureDm(speakerId: string, transcript: ChatTurn[], projects: Project[], fx: BotEffects): Promise<void> {
    return captureChain = captureChain.then(async () => {
      if (!(await deps.autoMemoryEnabled?.())) return;
      const { candidates, rejected, failed } = await extractMemories(
        transcript, await deps.loadMemories(speakerId), projects, { chat: deps.chat, model: deps.model }, { latestTurn: true },
      );
      // Counts only — a rejected candidate's text may be exactly what validation refused to keep.
      if (rejected > 0) console.warn(`[memory] DM capture rejected ${rejected} candidate(s)`);
      if (failed) throw new Error("extraction model call failed");
      if (candidates.length === 0) return;
      const at = new Date().toISOString();
      const batch: Memory[] = candidates.map((c) => ({ id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: at, subjectId: speakerId }));
      await deps.appendMemories(batch);
      for (const m of batch) {
        const projectName = m.projectPath ? projects.find((p) => p.path === m.projectPath)?.name : undefined;
        await fx.postCard(deps.cards.rememberedCard({ memoryId: m.id, text: m.text, projectName, scope: "private" }));
      }
    }).catch((err: unknown) => {
      console.error(`[memory] DM capture failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
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
  // The literal --model for a live session: kept only if that CLI's config offers it, else the
  // CLI's own default — a model from another provider never switches the engine.
  const liveModelFor = (cli: LiveCli, model: string | undefined): string | undefined =>
    model && (deps.cliModels.find((e) => e.provider === cli)?.models ?? []).includes(model) ? model : undefined;
  // The last started fresh live session's card picks, in model memory beside the delegate's
  // `teams:*` keys: a new card opens on them. "" = no skill / the CLI's default model.
  const LIVE_PROJECT = "live:project", LIVE_CLI = "live:cli", LIVE_SKILL = "live:skill";
  const liveModelKey = (cli: LiveCli): string => `live:model:${cli}`;

  // `/new` count per conversation (this process): a run launched before a reset must not
  // store its session afterwards and resurrect the pre-reset agent.
  const resets = new Map<string, number>();

  async function startRun(p: PendingProposal, cli: CliName, model: string | undefined, startedBy: string, fx: BotEffects): Promise<void> {
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
      if (p.cardActivityId !== undefined) {
        await fx.updateCard(p.cardActivityId, deps.cards.finishedCard({
          projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled",
        }));
      }
      await fx.post(`I can't find the \`${p.proposal.skillName}\` skill any more — ask me again and pick a skill that still exists.`);
      return;
    }
    // Thread sessions: continue this thread's earlier agent for the same CLI; another CLI
    // starts fresh, as does an opencode session from another project (RunRegistry.start; see
    // .memory/project-thread-sessions.md).
    const resume = deps.conversations.threadSession(p.conversationId, cli);
    const resetsAtLaunch = resets.get(p.conversationId) ?? 0;
    const req: DelegateRequest = {
      cli,
      projectPath: p.proposal.projectPath,
      prompt: skill ? composePrompt(skill, p.proposal.instruction) : p.proposal.instruction,
      ...(model !== undefined ? { model } : {}),
      ...(resume ? { resume } : {}),
      ...(skill?.browser ? { browser: true } : {}),
    };
    const receipt = (sessionId: string | undefined): { resume?: string; resumeLiveId?: string } =>
      sessionId
        ? {
            resume: resumeCommand(cli, sessionId),
            // Continue live only on the CLI that ran it, if it's still here, with that CLI's id shape.
            ...(liveClis().includes(cli) && isLiveSessionId(cli, sessionId) ? { resumeLiveId: sessionId } : {}),
          }
        : {};
    const cardId = p.cardActivityId;
    const updateTo = async (card: object): Promise<void> => {
      if (cardId !== undefined) await fx.updateCard(cardId, card);
    };
    let runId = "";
    const started = await deps.runs.start(
      req,
      {
        onTail: (line) => {
          updateTo(deps.cards.runningCard({ projectName, instruction: p.proposal.instruction, startedBy, tail: line, runId }))
            .catch(logRunEffectError);
        },
        onDone: (result, sessionId) => {
          void (async () => {
            if (sessionId && (resets.get(p.conversationId) ?? 0) === resetsAtLaunch) {
              deps.conversations.setThreadSession(p.conversationId, cli, sessionId);
            }
            deps.conversations.append(p.conversationId, { role: "assistant", content: `[delegate result] ${result}` });
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "done", ...receipt(sessionId) })).catch(logRunEffectError);
            await (fx.postResult ?? fx.post)(result);
          })().catch(logRunEffectError);
        },
        onError: (message, sessionId) => {
          void (async () => {
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "error", ...receipt(sessionId) })).catch(logRunEffectError);
            await fx.post(`Delegate run failed: ${message}`);
          })().catch(logRunEffectError);
        },
        onCancelled: (sessionId) => {
          void (async () => {
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled", ...receipt(sessionId) })).catch(logRunEffectError);
            await fx.post("Run cancelled.");
          })().catch(logRunEffectError);
        },
      },
      { instruction: p.proposal.instruction, conversationId: p.conversationId },
    );
    runId = started;
    await updateTo(deps.cards.runningCard({ projectName, instruction: p.proposal.instruction, startedBy, runId }));
    const memory = await deps.loadModelMemory();
    await deps.saveModelMemory({ ...memory, ...memoryUpdatesFor({ cli, model }) });
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
    if (refusal) {
      await updateTo(deps.cards.liveSessionResultCard({ projectName: await projectLabel(resume?.projectPath ?? p.proposal.projectPath, !!resume), startedBy, outcome: "cancelled" }));
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
    const started = deps.liveSessions.start({
      channelId: p.conversationId,
      projectPath: p.proposal.projectPath,
      instruction,
      ask: p.proposal.instruction,
      cli,
      model: liveModelFor(cli, p.proposal.model),
      ...(resume ? { resume: resume.sessionId } : {}),
      starterId,
      // Default restricted: only the starter (+ any co-drivers they add) steers, unless they
      // flipped the card to war-room.
      steering: p.proposal.steering ?? "restricted",
      sink,
      onTurnResult: (result) =>
        deps.conversations.append(p.conversationId, { role: "assistant", content: `[live session] ${result}` }),
      // A `/new` since launch unbound the conversation; a late id must not bind it again.
      ...(owner ? {
        onSessionId: (id: string) => {
          if ((resets.get(conv) ?? 0) === resetsAtLaunch) deps.catalog?.setLiveSession(conv, cli, id);
        },
      } : {}),
      onEnded: (notice) => {
        updateToEnded().catch(logRunEffectError);
        fx.post(notice).catch(logRunEffectError);
      },
    });
    async function updateToEnded(): Promise<void> {
      // The session id doesn't change across a resume, so the ended card can offer it again.
      await updateTo(deps.cards.liveSessionResultCard({
        projectName, startedBy, outcome: "ended", ...(resume ? { resumeLiveId: resume.sessionId } : {}),
      }));
    }
    if (started === "channel") {
      if (!quiet) await fx.post("A live session is already running in this channel — say `stop` to end it first.");
      return { refused: "channel-busy" };
    }
    await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "started" }));
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
    await postLiveSessionProposal({
      // No opening turn: the session opens on the channel's first message.
      projectPath: run.projectPath, instruction: "", steering: "restricted",
      resume: { sessionId: run.sessionId, projectPath: run.projectPath, instruction: run.instruction, cli: run.cli },
    }, conversationId, proposedBy, fx);
    return undefined;
  }

  async function handleNoteAction(
    kind: "save-note" | "cancel-note",
    proposalId: string | undefined,
    actor: string,
    conversationId: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.noteProposals.claim(proposalId, conversationId);
    if (!pending) {
      await fx.post("That note draft expired — ask me to take the note again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled"): object =>
      deps.cards.noteResultCard({ title: pending.note.title, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-note") {
      await updateTo(resultCard("cancelled"));
      return;
    }
    try {
      const body = pending.images?.length && deps.saveNoteImage
        ? await attachNoteImages(deps.saveNoteImage, pending.note.body, pending.images)
        : pending.note.body;
      await deps.saveNote({
        title: pending.note.title, body,
        project: pending.note.project, slug: pending.note.slug, source: "chat",
      });
      await updateTo(resultCard("saved"));
      await fx.post(`Saved note "${pending.note.title}".`);
    } catch (err) {
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
    const pending = deps.noteArchiveProposals.claim(proposalId, conversationId);
    if (!pending) {
      await fx.post("That archive request expired — ask me again.");
      return;
    }
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-archive-note") {
      await updateTo(deps.cards.noteArchiveResultCard({ title: pending.title, by: actor, outcome: "cancelled" }));
      return;
    }
    try {
      if (!(await deps.archiveNote(pending.slug))) {
        await fx.post(`"${pending.title}" is already archived or gone.`);
        return;
      }
      await updateTo(deps.cards.noteArchiveResultCard({ title: pending.title, by: actor, outcome: "archived", noteId: pending.slug }));
    } catch (err) {
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
    kind: "queue-todo" | "cancel-todo",
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
    const pending = deps.todoProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That todo draft expired — ask me to queue it again.");
      return;
    }
    const resultCard = (outcome: "queued" | "cancelled"): object =>
      deps.cards.todoResultCard({ routine: pending.todo.routine, queuedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-todo") {
      await updateTo(resultCard("cancelled"));
      return;
    }
    try {
      const routine = await deps.queueTodo(pending.todo.routine, pending.todo.text, pending.member ? pending.requesterId : undefined);
      await updateTo(resultCard("queued"));
      const when = routine ? todoRunHint(routine, new Date()) : "";
      await fx.post(`Queued on "${pending.todo.routine}".${when ? ` ${when}` : ""}`);
    } catch (err) {
      await fx.post(`Couldn't queue the todo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSkillAction(
    kind: "save-skill" | "cancel-skill",
    proposalId: string | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.skillProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That skill draft expired — ask me to draft it again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled"): object =>
      deps.cards.skillResultCard({ name: pending.skill.name, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-skill") {
      await updateTo(resultCard("cancelled"));
      return;
    }
    try {
      await deps.saveSkill(pending.skill.name, pending.skill.body);
      await updateTo(resultCard("saved"));
      await fx.post(`Saved skill "${pending.skill.name}".`);
    } catch (err) {
      await fx.post(`Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function runRoutineCommand(c: RoutineCommand): Promise<string> {
    const r = deps.routines!;
    const all = await r.load();
    if (c.kind === "list") return routineListText(all);
    // Exact name, else a unique case-insensitive match (phones capitalize the first letter).
    const loose = all.filter((x) => x.name.toLowerCase() === c.name.toLowerCase());
    const target = all.find((x) => x.name === c.name) ?? (loose.length === 1 ? loose[0] : undefined);
    if (!target) return `No sprout named "${c.name}". Say \`sprouts\` to list them.`;
    const on = c.kind === "enable";
    if (target.enabled === on) return `"${target.name}" is already ${on ? "on" : "off"}.`;
    const next = { ...target, enabled: on };
    await r.save(next);
    return on ? `Turned "${target.name}" on. ${todoRunHint(next, new Date())}`.trim() : `Turned "${target.name}" off.`;
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
    const peek = r.proposals.get(proposalId);
    if (!peek) {
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
      await fx.post(expired);
      return;
    }
    // A non-owner's Save always lands switched off, whatever the draft (or a forged toggle) says.
    const routine = isOwner ? pending.proposal.routine : { ...pending.proposal.routine, enabled: false };
    const name = String(routine.name);
    const resultCard = (outcome: "saved" | "cancelled" | "failed", problem?: string): object | undefined =>
      deps.cards.routineResultCard?.({ name, by: action.fromName, outcome, enabled: routine.enabled, ...(problem ? { problem } : {}) });
    if (kind === "cancel-routine") {
      await updateTo(resultCard("cancelled"));
      return;
    }
    const fail = async (problem: string): Promise<void> => {
      await updateTo(resultCard("failed", problem));
      await fx.post(`Couldn't save the sprout: ${problem}`);
    };
    // Re-validated at save: the household or clis.json may have changed while the card sat.
    const problem = pending.proposal.problem ?? chatRoutineProblem(routine, r.transport, recipients, deps.cliModels, pending.channelId);
    if (problem) {
      await fail(problem);
      return;
    }
    // An admin's draft never replaces a routine: case-insensitive check here (the filesystem may
    // be case-sensitive), then a create-only write for the race.
    const createOnly = !isOwner || !pending.byOwner;
    if (createOnly && (await r.load()).some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      await fail(nameTaken(name));
      return;
    }
    try {
      await (createOnly ? r.create(routine) : r.save(routine));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") await fail(nameTaken(name));
      else await fx.post(`Couldn't save the sprout: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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
    else await fx.post(text === undefined ? "Already forgotten." : "Only the owner can forget household facts or another member's.");
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
    const text = (await deps.loadMemories(null)).find((m) => m.id === memoryId)?.text;
    await fx.post(`Shared with the household (by ${actor}): ${text ?? "that fact"}. Only the owner can forget it now.`);
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
        await fx.reply(chatter.memoryOn(scopeId) ? "Channel memory is on here — I remember household facts people share. `memory off` to stop."
          : "Channel memory is off here — I only remember what someone explicitly asks me to.");
        return;
      }
      if (!(await permittedFor(role, scopeId, fx)("channelMemory", "turn channel memory on or off"))) return;
      chatter.setMemoryOn(scopeId, c.arg === "on");
      await (fx.announce ?? fx.reply)(c.arg === "on"
        ? `Channel memory is on${msg.channelName ? ` in ${msg.channelName}` : ""} — I'll remember household facts people share here.`
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
      const as = { owner: "the owner", admin: "an admin", member: "a household member", guest: "a guest" }[role];
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
      deps.conversations.clear(conv);
      deps.noteProposals.forgetImages(conv);
      resets.set(conv, (resets.get(conv) ?? 0) + 1);
      // Also fence off pre-reset channel chatter so it can't leak back in as ambient.
      deps.conversations.setAmbientCutoff(conv, Date.now());
      await fx.reply("Fresh start — I've cleared this conversation's context.");
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

  // Refused text (a per-turn CLI's next-turn queue is full) never reaches history.
  function steerLive(conv: string, fromName: string, text: string): boolean {
    if (!deps.liveSessions.send(conv, text)) return false;
    deps.conversations.append(conv, { role: "user", content: speakerLine(fromName, text) });
    return true;
  }

  // Desk turns running right now, across conversations — the bot-busy cap.
  // ponytail: one global cap; per-conversation if the desk ever sends in bulk.
  let deskInFlight = 0;
  const MAX_DESK_IN_FLIGHT = 4;
  // Desk Continue live clicks between their checks and the registry's bind (effects() awaits): a
  // second one for the same conversation is channel-busy, never a second session.
  const deskResuming = new Set<string>();

  const bot: ReturnType<typeof buildTeamsBot> = {
    onCommand,

    async onDeskTurn(req, effects, ack): Promise<void> {
      const conv = req.conversationId;
      const text = req.text.trim();
      if (text.length > MAX_DESK_TEXT) return ack({ refused: "too-long" });
      const row = deps.catalog?.get(conv);
      if (!row) return ack({ refused: "no-record" });
      // The id to act as is the one the catalog recorded, never one the request names, and it
      // must still be the configured owner (a changed owner config hides the old owner's rows).
      const owner = { fromId: row.ownerId, fromAltId: row.ownerAltId };
      if (deps.roles.roleOf(owner) !== "owner") return ack({ refused: "not-eligible" });
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
        // Re-checked after the echo's await: a session that ended meanwhile takes a normal turn.
        if (deps.liveSessions.has(conv)) {
          deps.conversations.setAmbientCutoff(conv, Date.now());
          return ack(steerLive(conv, fromName, text) ? { ok: true } : { refused: "queue-full" });
        }
        ack({ ok: true });
        const direct = row.kind === "dm";
        await bot.onMessage({
          conversationId: conv, text, ...owner, fromName, direct,
          ...(direct ? {} : { scopeId: target.scopeId }),
          channelName: direct ? "DM" : row.title,
        }, target.fx);
      } finally {
        deskInFlight--;
      }
    },

    async onDeskResume(req, effects, ack): Promise<void> {
      const conv = req.conversationId;
      const catalog = deps.catalog;
      const row = catalog?.get(conv);
      if (!catalog || !row) return ack({ refused: "no-record" });
      const owner = { fromId: row.ownerId, fromAltId: row.ownerAltId };
      if (deps.roles.roleOf(owner) !== "owner") return ack({ refused: "not-eligible" });
      if (deps.liveSessions.has(conv) || deskResuming.has(conv)) return ack({ refused: "channel-busy" });
      // The catalog binding and the delegate_runs row must agree on surface, CLI and session; the
      // project comes from the row (findDelegateRun checks the folder still exists). A
      // conversation with no recorded session never starts fresh.
      const found = row.liveCli && row.liveSessionId ? deps.findDelegateRun?.(row.liveSessionId) : undefined;
      if (!found || "refusal" in found || found.run.surface !== catalog.surface || found.run.cli !== row.liveCli) {
        return ack({ refused: "no-record" });
      }
      const { run } = found;
      if (!isLiveCli(run.cli)) return ack({ refused: "no-record" });
      if (!liveClis().includes(run.cli)) return ack({ refused: "cli-missing" });
      deskResuming.add(conv);
      try {
        let fx: BotEffects;
        try {
          fx = (await effects()).fx;
        } catch (err) {
          console.warn("bean: desk resume target failed:", err instanceof Error ? err.name : "error");
          return ack({ refused: "post-failed" });
        }
        const startedBy = deps.roles.ownerName;
        const pending: PendingLiveSession = {
          id: "desk", conversationId: conv, proposedBy: startedBy, createdAt: Date.now(),
          proposal: {
            projectPath: run.projectPath, instruction: "", steering: "restricted",
            resume: { sessionId: run.sessionId, projectPath: run.projectPath, instruction: run.instruction, cli: run.cli },
          },
        };
        let result: DeskAckResult;
        try {
          result = await startLiveSessionAction(pending, startedBy, row.ownerId, fx,
            { altId: row.ownerAltId, place: { kind: row.kind, title: row.title } }, true);
        } catch (err) {
          // The mode line's post failed after the bind: the session is open all the same.
          console.warn("bean: desk resume post failed:", err instanceof Error ? err.name : "error");
          result = deps.liveSessions.has(conv) ? { ok: true } : { refused: "post-failed" };
        }
        ack(result);
      } finally {
        deskResuming.delete(conv);
      }
    },

    onAmbient(conversationId, scopeId, fx, line) {
      chimeIn?.onAmbient(conversationId, scopeId, fx);
      channelCapture?.onLine(conversationId, scopeId, line, fx);
    },

    proposeLiveSession(args, fx): Promise<string> {
      return proposeLiveSessionFrom(args.conversationId, args.instruction, args.proposedBy, fx);
    },

    async onMessage(msg: IncomingMessage, fx: BotEffects): Promise<void> {
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
          if (cmd === "stop" || cmd === "drivers") {
            await onCommand(msg, fx);
            return;
          }
          // A start/resume while one runs is never a steer: the owner hears why, anyone else is dropped.
          if (/^\/?live-session\b/i.test(trimmed)) {
            if (speakerRole(msg).role === "owner") await fx.reply(liveBusyLine(deps.liveSessions.cli(conv) ?? "claude"));
            return;
          }
          if (!steers(msg)) return;
          if (!steerLive(conv, msg.fromName, msg.text)) await fx.reply(TURN_QUEUE_FULL);
          return;
        }
        // Typed `stop` with nothing live stays a model turn, as it always was.
        if (cmd !== "stop" && await onCommand(msg, fx)) return;
        const { role, scopeId } = speakerRole(msg);
        const isOwner = role === "owner";
        if (await dmBlocked(msg, role, fx)) return;
        // The owner's own DM is continuable from the desktop; a member's DM never is.
        if (msg.direct && isOwner) {
          deps.catalog?.upsert({ conversationId: msg.conversationId, place: { kind: "dm", title: "DM" }, ownerId: msg.fromId, ownerAltId: msg.fromAltId });
        }
        const permitted = permittedFor(role, scopeId, fx);
        turnId = randomUUID();
        deps.onActivity?.({ type: "turn", phase: "start", id: turnId, who: msg.fromName, where: msg.channelName });
        // Guests get Bean's own model and nothing else: no catalog, recall, or todo/delegate tools.
        // Members get recall, notes and todo queues (projects scope those), but no skill catalog.
        const canDelegate = can(role, "delegate");
        const canMemory = can(role, "memory");
        const [skills, projects, persona, memories, modelMemory, todoRoutines] = await Promise.all([
          canDelegate ? loadActiveSkills() : [],
          canDelegate || canMemory || can(role, "notes") ? deps.loadProjects() : [], deps.loadPersona(),
          // Recall is scoped before ranking: a DM sees the speaker's private facts plus shared
          // ones; a channel sees shared only.
          canMemory ? deps.loadMemories(msg.direct ? msg.fromId : null) : [], deps.loadModelMemory(), can(role, "todos") ? deps.listTodoRoutines(!isOwner) : [],
        ]);
        // Owner only: who a routine may DM, and the existing names a draft would replace. A channel
        // sink targets the channel, never the session thread (threads archive).
        const routineAuthoring = deps.routines && can(role, "routineDrafts")
          ? {
              transport: deps.routines.transport,
              // Admins draft new routines only, so they never see (or target) the catalog.
              existing: isOwner ? (await deps.routines.load()).map((r) => r.name) : [],
              recipients: await deps.routines.recipients(),
              ...(msg.direct || !msg.scopeId ? {} : { channelId: msg.scopeId }),
              cliModels: deps.cliModels,
            }
          : undefined;
        const detected = deps.detectClis();
        let history = deps.conversations.history(msg.conversationId);
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
            deps.conversations.append(msg.conversationId, { role: "user", content: block });
            history = [...history, { role: "user", content: block }];
          }
        }
        // The replied-to message: saved (once) like ambient so follow-ups still see it; an
        // unreadable one gets a hint for this turn's model hops only.
        const repliedHint: typeof history = msg.repliedTo?.unavailable ? [{ role: "user", content: REPLIED_UNAVAILABLE }] : [];
        if (msg.repliedTo && !msg.repliedTo.unavailable) {
          const block = formatRepliedBlock(msg.repliedTo);
          if (!history.some((t) => t.content === block)) {
            deps.conversations.append(msg.conversationId, { role: "user", content: block });
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
        const memoryTools = makeMemoryTools({
          append: deps.appendMemories, forget: (ids) => deps.deleteMemories(ids, isOwner ? undefined : msg.fromId),
          memories, projects, latestUserText: typed, ...(scope === "private" ? { subjectId: msg.fromId } : {}),
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
        // runAvailable=false: propose_run is never offered here — confirming one couldn't
        // execute anything from Teams/Discord; propose_delegate is the only run path.
        // The tool list is built from the role (action tools run inside converse(), so leaving
        // them out is their gate); proposals are re-checked against the role below.
        const actions = [
          ...(can(role, "notes") ? [noteTool] : []), ...(can(role, "systemControl") ? [systemTool] : []),
          ...(imageTool ? [imageTool.tool] : []),
        ];
        const converseBase = {
          skills, projects, persona, memories,
          deps: { chat: deps.chat, model: deps.model },
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
          routineAuthoring,
        };
        const result = await converse({
          ...converseBase,
          actions: [...converseBase.actions, ...(canMemory ? memoryTools.tools : []), ...(reminderTools?.tools ?? []), ...todoTools],
          history: [...history, ...repliedHint], latestUserText: msg.text, latestUserImages: msg.images,
        });
        turnFailed = result.error !== undefined;
        // History keeps only "[image attached]"; the bytes stay in bounded memory for a
        // follow-up "save that to a note". Before any proposal is added so the cap's
        // oldest-first eviction drops this slot, not the new proposal holding the same images.
        if (deps.saveNoteImage && msg.images?.length) deps.noteProposals.rememberImages(msg.conversationId, msg.images);
        deps.conversations.append(msg.conversationId, {
          role: "user",
          content: speakerLine(msg.fromName, msg.images?.length ? `${msg.text}\n[image attached]` : msg.text),
        });
        if (result.reply) {
          deps.conversations.append(msg.conversationId, { role: "assistant", content: result.reply });
          await fx.reply(result.reply);
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
              memoryId: m.id, text: m.text, projectName: m.projectPath ? nameFor(m.projectPath) : undefined, scope,
            }));
          }
        }
        // Only the speaker's typed words are citable (never an audio transcript); a turn that
        // already remembered or forgot something explicitly is left alone.
        if (msg.direct && canMemory && !turnFailed && typed.trim() && memoryTools.remembered.length === 0 && memoryTools.forgotten.length === 0) {
          capture = captureDm(msg.fromId, [...history, { role: "user", content: typed, source: "typed" }], projects, fx);
        }
        for (const r of reminderTools?.set ?? []) {
          if (deps.cards.reminderCard) await fx.postCard(deps.cards.reminderCard({ reminderId: r.id, text: r.text, at: r.at }));
        }
        void maybeCompact(msg.conversationId, deps.conversations, { chat: deps.chat, model: deps.model });
        if (result.proposedRun) {
          // A `target: chat` skill runs on Bean's own model: resend the composed prompt
          // through this same conversation (mirrors ChatWindow's confirmProposal). No
          // confirm card — it's just another chat reply, no agent harness or side effects.
          if (result.proposedRun.target === "chat") {
            if (!(await permitted("runSkills", "run skills"))) return;
            const run = result.proposedRun;
            const followup = await converse({
              ...converseBase,
              history: [...deps.conversations.history(msg.conversationId), ...repliedHint],
              latestUserText: run.composedPrompt,
            });
            deps.conversations.append(msg.conversationId, { role: "user", content: speakerLine(msg.fromName, run.composedPrompt) });
            // Nested proposals from the skill prompt are deliberately ignored — one hop only.
            // A pure tool-use second hop leaves reply empty; never answer with silence.
            const text = followup.reply.trim() ||
              `The ${run.skillName} skill didn't produce a reply — try asking me directly instead.`;
            deps.conversations.append(msg.conversationId, { role: "assistant", content: text });
            // reply, not post: this is the turn's answer, so surface extras (Discord voice
            // replies) apply to it too.
            await fx.reply(text);
            await deliverImages(); // the follow-up hop can call generate_image too
            return;
          }
          // Backstop only: terminal-target propose_run isn't offered from chatops, so this
          // can't fire from a well-behaved model — but if it does, point at what works.
          await fx.post(DESKTOP_ONLY);
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
          return;
        }
        if (result.proposedSkill) {
          if (!(await permitted("skillWrites", "save skills"))) return;
          const skill = result.proposedSkill;
          const pending = deps.skillProposals.add({ skill, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.skillProposalCard({
            proposalId: pending.id, name: skill.name, body: skill.body, updating: skill.updating,
          }));
          deps.skillProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        if (result.proposedTodo) {
          if (!(await permitted("todos", "queue tasks"))) return;
          const todo = result.proposedTodo;
          const pending = deps.todoProposals.add({
            todo, conversationId: msg.conversationId, proposedBy: msg.fromName, requesterId: msg.fromId, member: !isOwner,
          });
          const activityId = await fx.postCard(deps.cards.todoProposalCard({
            proposalId: pending.id, routine: todo.routine, text: todo.text,
          }));
          deps.todoProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        if (result.proposedRoutine) {
          if (!(await permitted("routineDrafts", "set up sprouts"))) return;
          if (!deps.routines || !deps.cards.routineProposalCard) return;
          let proposal = result.proposedRoutine;
          if (!isOwner && !proposal.problem) {
            // An admin's draft starts off, and a name clash is shown up front ("Can't save").
            const name = String(proposal.routine.name);
            const taken = (await deps.routines.load()).some((x) => x.name.toLowerCase() === name.toLowerCase());
            proposal = { ...proposal, routine: { ...proposal.routine, enabled: false }, ...(taken ? { problem: nameTaken(name) } : {}) };
          }
          const pending = deps.routines.proposals.add({
            proposal, conversationId: msg.conversationId, proposedBy: msg.fromName,
            proposedById: msg.fromId, byOwner: isOwner, ...(msg.channelName ? { where: msg.channelName } : {}),
            ...(routineAuthoring?.channelId ? { channelId: routineAuthoring.channelId } : {}),
          });
          const activityId = await fx.postCard(deps.cards.routineProposalCard(
            routineCardInput(pending, routineAuthoring?.recipients ?? [], deps.roles.ownerName),
          ));
          deps.routines.proposals.setCardActivityId(pending.id, activityId);
          return;
        }
        const proposal = result.proposedDelegate;
        if (!proposal) return;
        if (!(await permitted("delegate", "run tasks"))) return;
        const choice = resolveCliModel(detected, { cli: proposal.cli, model: proposal.model }, modelMemory, deps.cliModels);
        if (!choice) {
          await fx.post(NO_CLI);
          return;
        }
        const pending = deps.proposals.add({
          proposal, conversationId: msg.conversationId, proposedBy: msg.fromName,
          defaultCli: choice.cli, defaultModel: choice.model,
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
        await handleSkillAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
      if (beanAction === "save-routine" || beanAction === "cancel-routine" || beanAction === "toggle-routine") {
        await handleRoutineAction(beanAction, proposalId, action, role, fx);
        return;
      }
      if (beanAction === "queue-todo" || beanAction === "cancel-todo") {
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
        }
        const pending = deps.liveSessionProposals.claim(proposalId);
        if (!pending) {
          await fx.post("That live-session proposal expired — ask me to start one again.");
          return;
        }
        if (beanAction === "cancel-live") {
          const projectName = await projectLabel(pending.proposal.projectPath, !!pending.proposal.resume);
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled" }));
          }
          return;
        }
        // The proposal was only offered while live sessions were enabled, but it can sit
        // unclaimed for up to 10 minutes — re-check the gate here, the one place that
        // actually launches the permissions-bypassed process.
        if (!deps.liveSessionsEnabled()) {
          const projectName = await projectLabel(pending.proposal.projectPath, !!pending.proposal.resume);
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled" }));
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
        await fx.post(NO_CLI);
        return;
      }
      await startRun(p, choice.cli, choice.model, action.fromName, fx);
    },
  };
  return bot;
}
