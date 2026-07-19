import { randomUUID } from "node:crypto";
import { converse, type ConverseDeps, type ProposedLiveSession } from "../converse.js";
import { composePrompt } from "../prompt.js";
import { extractMemories } from "../memory/extract.js";
import { proposeMemoryConsolidation } from "../memory/consolidate.js";
import { availableModels } from "../models.js";
import type { Skill, Project } from "../types.js";
import type { Persona } from "../persona.js";
import type { Memory, MemoryCandidate } from "../memory/memory.js";
import type { CliName } from "../launcher.js";
import type { CliModels } from "../cli-models.js";
import type { DelegateRequest } from "../delegate.js";
import type { CardBuilders } from "./cards-api.js";
import { formatAmbientBlock, type AmbientMessage } from "./ambient.js";
import { memoryUpdatesFor, resolveCliModel } from "./resolve.js";
import type { ConversationStore } from "./conversation.js";
import { maybeCompact } from "./compact.js";
import type { PendingProposal, ProposalStore } from "./proposals.js";
import type { NoteProposalStore } from "./note-proposals.js";
import type { TodoProposalStore } from "./todo-proposals.js";
import type { MemoryProposalStore } from "./memory-proposals.js";
import type { ConsolidationProposalStore } from "./consolidation-proposals.js";
import type { SkillProposalStore } from "./skill-proposals.js";
import { retrieveNoteTool, type Note, type NoteDraft } from "../note-store.js";
import { systemControlTool } from "../system-control.js";
import type { RunRegistry } from "./runs.js";
import { LiveSessionProposalStore, type PendingLiveSession } from "./live-session-proposals.js";
import { LiveSessionRegistry, type LiveSessionSink } from "./live-sessions.js";

// Above this many total memories, a successful save-memories also offers a tidy-up (merge
// duplicates/drop stale) proposal — piggybacking on the existing extraction flow rather than
// a separate scheduler, per .memory/project-bean-memory.md.
const CONSOLIDATION_THRESHOLD = 30;

/** Only messages that explicitly address the bot (DM, @mention, or reply-to-bot) reach
 * onMessage — surfaces keep untagged channel chatter as ambient context instead. */
export interface IncomingMessage {
  conversationId: string;
  text: string;
  fromId: string;
  fromName: string;
  /** User-ids @mentioned in this message (excluding the bot), if the surface supplies them —
   * used by the live-session `+driver`/`-driver` commands. Surfaces that omit it can't use
   * mention-based co-driver management. */
  mentionedIds?: string[];
}

export interface CardAction {
  conversationId: string;
  /** Surface user-id of whoever tapped the card. Optional so existing tests/callers compile;
   * the live-session start path uses it as the session owner. */
  fromId?: string;
  fromName: string;
  value: { beanAction?: string; proposalId?: string; projectPath?: string; cli?: string; model?: string; memoryPicks?: string[] };
}

export interface BotEffects {
  reply: (text: string) => Promise<void>;
  postCard: (card: object) => Promise<string>;
  updateCard: (activityId: string, card: object) => Promise<void>;
  post: (text: string) => Promise<void>;
  /** Ambient channel messages (not addressed to Bean) since the given epoch ms, oldest first. */
  fetchRecent?: (sinceMs: number) => Promise<AmbientMessage[]>;
}

export interface TeamsBotDeps {
  chat: ConverseDeps["chat"];
  model: string;
  loadSkills: () => Promise<Skill[]>;
  loadProjects: () => Promise<Project[]>;
  loadPersona: () => Promise<Persona>;
  loadMemories: () => Promise<Memory[]>;
  loadModelMemory: () => Promise<Record<string, string>>;
  saveModelMemory: (m: Record<string, string>) => Promise<void>;
  detectClis: () => CliName[];
  cliModels: CliModels[]; // loaded once at boot from clis.json (repo default + ~/.bean override)
  runs: RunRegistry;
  proposals: ProposalStore;
  noteProposals: NoteProposalStore;
  /** Persists a confirmed note to the shared bean.db (server injects the db path). */
  saveNote: (draft: NoteDraft) => Promise<string>;
  /** FTS5 search over saved notes (server injects the db path); backs retrieve_note. */
  searchNotes: (query: string) => Promise<Note[]>;
  todoProposals: TodoProposalStore;
  /** Queues a confirmed todo (server injects the db path + routine validation). */
  queueTodo: (routine: string, text: string) => Promise<void>;
  /** Names of routines with todoDriven=true — gates the propose_todo tool. */
  listTodoRoutines: () => Promise<string[]>;
  skillProposals: SkillProposalStore;
  /** Persists a confirmed skill draft to the user's ~/.bean/skills (server injects the dir). */
  saveSkill: (name: string, body: string) => Promise<void>;
  memoryProposals: MemoryProposalStore;
  /** Insert-only add of new facts — never lose a concurrent writer's addition (see
   * memory/store.ts's appendMemories doc comment). */
  appendMemories: (additions: Memory[]) => Promise<void>;
  /** Whole-list replace, only for consolidation's merge/drop apply (a genuine read-modify-write,
   * gated behind a one-shot claimed proposal so it isn't the same race as free-form appends). */
  saveMemories: (memories: Memory[]) => Promise<void>;
  consolidationProposals: ConsolidationProposalStore;
  conversations: ConversationStore;
  cards: CardBuilders;
  /** Gates the system_control action tool, same as main.ts's desktop wiring. */
  systemControlsEnabled: () => boolean;
  /** Active chat-bridged agent sessions; while a channel is bound, its messages bypass converse. */
  liveSessions: LiveSessionRegistry;
  liveSessionProposals: LiveSessionProposalStore;
  /** Gates the propose_live_session tool (config liveSessions flag + surface support). */
  liveSessionsEnabled: () => boolean;
}

const DESKTOP_ONLY =
  "That needs the Bean desktop app — from here I can only chat and run background delegate tasks. Ask me again and I'll run it as one.";
const NO_CLI = "I can't run delegate tasks: neither `claude` nor `opencode` is on this machine's PATH.";

export function buildTeamsBot(deps: TeamsBotDeps): {
  onMessage: (msg: IncomingMessage, fx: BotEffects) => Promise<void>;
  onCardAction: (action: CardAction, fx: BotEffects) => Promise<void>;
  /** Explicit /live-session entry: validate + post the same confirm card the LLM path posts.
   * Returns a short line for the invoker (surface shows it as an ephemeral ack). */
  proposeLiveSession: (
    args: { conversationId: string; instruction: string; proposedBy: string },
    fx: BotEffects,
  ) => Promise<string>;
} {
  const actions = [retrieveNoteTool(deps.searchNotes), systemControlTool(deps.systemControlsEnabled)];

  async function startRun(p: PendingProposal, cli: CliName, model: string | undefined, startedBy: string, fx: BotEffects): Promise<void> {
    const projects = await deps.loadProjects();
    const projectName = projects.find((pr) => pr.path === p.proposal.projectPath)?.name ?? p.proposal.projectPath;
    const req: DelegateRequest = {
      cli,
      projectPath: p.proposal.projectPath,
      prompt: p.proposal.composedPrompt,
      ...(model !== undefined ? { model } : {}),
    };
    const cardId = p.cardActivityId;
    const updateTo = async (card: object): Promise<void> => {
      if (cardId !== undefined) await fx.updateCard(cardId, card);
    };
    const started = await deps.runs.start(
      req,
      {
        onTail: (line) => {
          void updateTo(deps.cards.runningCard({ projectName, instruction: p.proposal.instruction, startedBy, tail: line, projectPath: req.projectPath }));
        },
        onDone: (result) => {
          void (async () => {
            deps.conversations.append(p.conversationId, { role: "assistant", content: `[delegate result] ${result}` });
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "done" }));
            await fx.post(result);
          })();
        },
        onError: (message) => {
          void (async () => {
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "error" }));
            await fx.post(`Delegate run failed: ${message}`);
          })();
        },
        onCancelled: () => {
          void (async () => {
            await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled" }));
            await fx.post("Run cancelled.");
          })();
        },
      },
      { instruction: p.proposal.instruction, conversationId: p.conversationId },
    );
    if (!started) {
      await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled" }));
      await fx.post("A run is already going in that project — wait for it or cancel it first.");
      return;
    }
    await updateTo(deps.cards.runningCard({ projectName, instruction: p.proposal.instruction, startedBy, projectPath: req.projectPath }));
    const memory = await deps.loadModelMemory();
    await deps.saveModelMemory({ ...memory, ...memoryUpdatesFor({ cli, model }) });
  }

  async function startLiveSessionAction(p: PendingLiveSession, startedBy: string, starterId: string, fx: BotEffects): Promise<void> {
    const projects = await deps.loadProjects();
    const projectName = projects.find((pr) => pr.path === p.proposal.projectPath)?.name ?? p.proposal.projectPath;
    const updateTo = async (card: object): Promise<void> => {
      if (p.cardActivityId !== undefined) await fx.updateCard(p.cardActivityId, card);
    };
    // Plain-text stream messages ride the card channel: postCard({content}) / updateCard(id, {content}).
    const sink: LiveSessionSink = {
      post: (text) => fx.postCard({ content: text }),
      edit: (id, text) => fx.updateCard(id, { content: text }),
    };
    // A picked skill's body frames the opening turn (composePrompt = body + "## Task" + text).
    const skill = p.proposal.skillName
      ? (await deps.loadSkills()).find((s) => s.name === p.proposal.skillName)
      : undefined;
    const instruction = skill ? composePrompt(skill, p.proposal.instruction) : p.proposal.instruction;
    const started = deps.liveSessions.start({
      channelId: p.conversationId,
      projectPath: p.proposal.projectPath,
      instruction,
      model: p.proposal.model,
      starterId,
      // Default restricted: only the starter (+ any co-drivers they add) steers, unless they
      // flipped the card to war-room.
      steering: p.proposal.steering ?? "restricted",
      sink,
      onTurnResult: (result) =>
        deps.conversations.append(p.conversationId, { role: "assistant", content: `[live session] ${result}` }),
      onEnded: (notice) => {
        void updateToEnded();
        void fx.post(notice);
      },
    });
    async function updateToEnded(): Promise<void> {
      await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "ended" }));
    }
    if (!started) {
      await fx.post("A live session is already running in this channel — say `stop` to end it first.");
      return;
    }
    await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "started" }));
    const mode = p.proposal.steering ?? "restricted";
    await fx.post(mode === "open"
      ? "War-room mode: anyone here can steer. Say `stop` to end it."
      : "Restricted mode: only you steer. Add co-drivers with `+driver @name`, remove with `-driver @name`. Say `stop` to end it.");
  }

  // Post the confirm-first Start/Cancel card. Shared by the LLM path (propose_live_session)
  // and the explicit /live-session command — both just fill in a ProposedLiveSession.
  async function postLiveSessionProposal(
    live: ProposedLiveSession, conversationId: string, proposedBy: string, fx: BotEffects,
  ): Promise<void> {
    const [projects, skills] = await Promise.all([deps.loadProjects(), deps.loadSkills()]);
    const projectName = projects.find((p) => p.path === live.projectPath)?.name ?? live.projectPath;
    // Live sessions always run claude, so only claude's models/CLI are offered.
    const models = (deps.cliModels.find((e) => e.provider === "claude")?.models ?? [])
      .map((id) => ({ id, label: id.split("/").pop() || id }));
    const clis = deps.detectClis().filter((c) => c === "claude");
    const pending = deps.liveSessionProposals.add({ proposal: live, conversationId, proposedBy });
    const activityId = await fx.postCard(deps.cards.liveSessionProposalCard({
      proposalId: pending.id, projectName, instruction: live.instruction, model: live.model, skillName: live.skillName,
      projects: projects.map((p) => ({ name: p.name, path: p.path })), models,
      skills: skills.filter((s) => !s.hidden).map((s) => ({ name: s.name })), clis,
    }));
    deps.liveSessionProposals.setCardActivityId(pending.id, activityId);
  }

  async function handleNoteAction(
    kind: "save-note" | "cancel-note",
    proposalId: string | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.noteProposals.claim(proposalId);
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
      await deps.saveNote({
        title: pending.note.title, body: pending.note.body,
        project: pending.note.project, slug: pending.note.slug, source: "chat",
      });
      await updateTo(resultCard("saved"));
      await fx.post(`Saved note "${pending.note.title}".`);
    } catch (err) {
      await fx.post(`Couldn't save the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleTodoAction(
    kind: "queue-todo" | "cancel-todo",
    proposalId: string | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
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
      await deps.queueTodo(pending.todo.routine, pending.todo.text);
      await updateTo(resultCard("queued"));
      await fx.post(`Queued on "${pending.todo.routine}".`);
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

  async function handleMemoryAction(
    kind: "save-memories" | "cancel-memories",
    proposalId: string | undefined,
    memoryPicks: string[] | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.memoryProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That memory batch expired — ask me to remember again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled", count: number): object =>
      deps.cards.memoryResultCard({ count, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-memories") {
      await updateTo(resultCard("cancelled", 0));
      return;
    }
    // undefined picks = the platform's "all selected" default (e.g. Discord's untouched menu).
    const selected = memoryPicks === undefined
      ? pending.candidates
      : memoryPicks.map((i) => pending.candidates[Number(i)]).filter((c): c is MemoryCandidate => c !== undefined);
    if (selected.length === 0) {
      await updateTo(resultCard("cancelled", 0));
      await fx.post("Didn't remember anything — nothing was selected.");
      return;
    }
    try {
      const now = new Date().toISOString();
      // randomUUID, not Date.now()-based: `id` is a SQLite PRIMARY KEY, so two processes
      // generating an id in the same millisecond would collide and fail the INSERT.
      const additions: Memory[] = selected.map((c) => ({
        id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: now,
      }));
      // Insert-only: never lose a concurrent writer's addition (see appendMemories's doc comment).
      await deps.appendMemories(additions);
      await updateTo(resultCard("saved", selected.length));
      await fx.post(`Remembered ${selected.length} fact(s).`);
      const all = await deps.loadMemories();
      await maybeProposeConsolidation(all, pending.conversationId, fx);
    } catch (err) {
      await fx.post(`Couldn't save memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function maybeProposeConsolidation(memories: Memory[], conversationId: string, fx: BotEffects): Promise<void> {
    if (memories.length <= CONSOLIDATION_THRESHOLD) return;
    const result = await proposeMemoryConsolidation(memories, { chat: deps.chat, model: deps.model });
    if (result.merges.length === 0 && result.drops.length === 0) return;
    const pending = deps.consolidationProposals.add({ result, conversationId });
    const merges = result.merges.map((m) => ({ mergedText: m.mergedText, count: m.ids.length }));
    const drops = result.drops.map((id) => memories.find((m) => m.id === id)?.text ?? id);
    const activityId = await fx.postCard(deps.cards.consolidationProposalCard({ proposalId: pending.id, merges, drops }));
    deps.consolidationProposals.setCardActivityId(pending.id, activityId);
  }

  async function handleConsolidationAction(
    kind: "confirm-consolidation" | "cancel-consolidation",
    proposalId: string | undefined,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.consolidationProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That tidy-up suggestion expired.");
      return;
    }
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-consolidation") {
      await updateTo(deps.cards.consolidationResultCard({ outcome: "cancelled" }));
      return;
    }
    try {
      const existing = await deps.loadMemories();
      const mergedIds = new Set(pending.result.merges.flatMap((m) => m.ids));
      const droppedIds = new Set(pending.result.drops);
      const kept = existing.filter((m) => !mergedIds.has(m.id) && !droppedIds.has(m.id));
      const now = new Date().toISOString();
      const merged: Memory[] = pending.result.merges.map((m) => {
        const projectPath = existing.find((mm) => m.ids.includes(mm.id) && mm.projectPath)?.projectPath;
        return { id: randomUUID(), text: m.mergedText, projectPath, createdAt: now };
      });
      await deps.saveMemories([...kept, ...merged]);
      await updateTo(deps.cards.consolidationResultCard({ outcome: "applied" }));
      await fx.post("Memory tidied up.");
    } catch (err) {
      await fx.post(`Couldn't tidy up memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Post a live-session proposal from a verbatim instruction — no converse()/LLM in the path, so
  // the prompt reaches the card (and then claude) exactly as typed. Shared by the /live-session
  // slash command and its literal-text form in onMessage. Returns a one-line status for the caller.
  async function proposeLiveSessionFrom(conversationId: string, instruction: string, proposedBy: string, fx: BotEffects): Promise<string> {
    if (!deps.liveSessionsEnabled()) return "Live sessions are disabled here.";
    const text = instruction.trim();
    if (!text) return "Add a prompt after `/live-session` — e.g. `/live-session investigate the auth bug`.";
    const projects = await deps.loadProjects();
    const first = projects[0];
    if (!first) return "No projects are configured — add one first.";
    // Project/model are picked on the card; default to the first project (user can switch).
    const live: ProposedLiveSession = { projectPath: first.path, instruction: text };
    await postLiveSessionProposal(live, conversationId, proposedBy, fx);
    return "Proposed a live session — pick the project/model, edit the prompt if you want, then Start.";
  }

  return {
    proposeLiveSession(args, fx): Promise<string> {
      return proposeLiveSessionFrom(args.conversationId, args.instruction, args.proposedBy, fx);
    },

    async onMessage(msg: IncomingMessage, fx: BotEffects): Promise<void> {
      try {
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
          // Bystanders in restricted mode: kept out of the agent, but their message is still
          // fenced from ambient replay above so it can't leak back in after the session ends.
          if (!deps.liveSessions.canSteer(conv, msg.fromId)) return;
          if (lower === "drivers") {
            const co = deps.liveSessions.coDrivers(conv);
            await fx.reply(co.length === 0 ? "No co-drivers yet." : `Co-drivers: ${co.length}.`);
            return;
          }
          if (lower === "stop") {
            deps.liveSessions.stop(conv);
            return; // the registry's onEnded posts the end notice
          }
          deps.conversations.append(conv, { role: "user", content: msg.text });
          deps.liveSessions.send(conv, msg.text);
          return;
        }
        if (msg.text.trim().toLowerCase() === "cancel") {
          const n = deps.runs.cancelAll();
          await fx.reply(n > 0 ? `Cancelled ${n} run(s).` : "Nothing is running.");
          return;
        }
        if (msg.text.trim().toLowerCase() === "/new") {
          deps.conversations.clear(msg.conversationId);
          // Also fence off pre-reset channel chatter so it can't leak back in as ambient.
          deps.conversations.setAmbientCutoff(msg.conversationId, Date.now());
          await fx.reply("Fresh start — I've cleared this conversation's context.");
          return;
        }
        // Literal `/live-session <prompt>` typed as a message (not Discord's slash-command
        // picker): route it verbatim, bypassing converse(), so the LLM never rewrites the prompt
        // the way it does for free-form "start a live session…" phrasing.
        const liveCmd = /^\/?live-session\b\s*([\s\S]*)$/i.exec(msg.text.trim());
        if (liveCmd) {
          await fx.reply(await proposeLiveSessionFrom(msg.conversationId, liveCmd[1] ?? "", msg.fromName, fx));
          return;
        }
        const [skills, projects, persona, memories, modelMemory, todoRoutines] = await Promise.all([
          deps.loadSkills(), deps.loadProjects(), deps.loadPersona(), deps.loadMemories(), deps.loadModelMemory(),
          deps.listTodoRoutines(),
        ]);
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
        // runAvailable=false: propose_run is never offered here — confirming one couldn't
        // execute anything from Teams/Discord; propose_delegate is the only run path.
        const converseBase = {
          skills, projects, persona, memories,
          deps: { chat: deps.chat, model: deps.model },
          actions,
          delegateAvailable: true,
          liveSessionAvailable: deps.liveSessionsEnabled() && detected.includes("claude"),
          availableClis: detected,
          models: availableModels(deps.cliModels, detected),
          rememberAvailable: true,
          runAvailable: false,
          todoRoutines,
        };
        const result = await converse({ ...converseBase, history, latestUserText: msg.text });
        deps.conversations.append(msg.conversationId, { role: "user", content: msg.text });
        if (result.reply) {
          deps.conversations.append(msg.conversationId, { role: "assistant", content: result.reply });
          await fx.reply(result.reply);
        }
        void maybeCompact(msg.conversationId, deps.conversations, { chat: deps.chat, model: deps.model });
        if (result.proposedRun) {
          // A `target: chat` skill runs on Bean's own model: resend the composed prompt
          // through this same conversation (mirrors ChatWindow's confirmProposal). No
          // confirm card — it's just another chat reply, no agent harness or side effects.
          if (result.proposedRun.target === "chat") {
            const run = result.proposedRun;
            const followup = await converse({
              ...converseBase,
              history: deps.conversations.history(msg.conversationId),
              latestUserText: run.composedPrompt,
            });
            deps.conversations.append(msg.conversationId, { role: "user", content: run.composedPrompt });
            // Nested proposals from the skill prompt are deliberately ignored — one hop only.
            // A pure tool-use second hop leaves reply empty; never answer with silence.
            const text = followup.reply.trim() ||
              `The ${run.skillName} skill didn't produce a reply — try asking me directly instead.`;
            deps.conversations.append(msg.conversationId, { role: "assistant", content: text });
            await fx.post(text);
            return;
          }
          // Backstop only: terminal-target propose_run isn't offered from chatops, so this
          // can't fire from a well-behaved model — but if it does, point at what works.
          await fx.post(DESKTOP_ONLY);
          return;
        }
        if (result.proposedLiveSession) {
          await postLiveSessionProposal(result.proposedLiveSession, msg.conversationId, msg.fromName, fx);
          return;
        }
        if (result.proposedNote) {
          const note = result.proposedNote;
          const projectName = note.project
            ? (projects.find((p) => p.path === note.project)?.name ?? note.project)
            : undefined;
          const pending = deps.noteProposals.add({ note, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.noteProposalCard({
            proposalId: pending.id, title: note.title, body: note.body, projectName, updating: note.slug !== undefined,
          }));
          deps.noteProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        if (result.proposedSkill) {
          const skill = result.proposedSkill;
          const pending = deps.skillProposals.add({ skill, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.skillProposalCard({
            proposalId: pending.id, name: skill.name, body: skill.body, updating: skill.updating,
          }));
          deps.skillProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        if (result.proposedTodo) {
          const todo = result.proposedTodo;
          const pending = deps.todoProposals.add({ todo, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.todoProposalCard({
            proposalId: pending.id, routine: todo.routine, text: todo.text,
          }));
          deps.todoProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        if (result.proposedRemember) {
          const transcript = [...history, { role: "user" as const, content: msg.text }];
          const candidates = await extractMemories(
            transcript, memories, projects, { chat: deps.chat, model: deps.model },
          );
          if (candidates.length === 0) {
            await fx.post("Nothing here worth remembering long-term.");
            return;
          }
          const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
          const facts = candidates.map((c) => ({
            text: c.text, projectName: c.projectPath ? nameFor(c.projectPath) : undefined,
          }));
          const pending = deps.memoryProposals.add({ candidates, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.memoryProposalCard({ proposalId: pending.id, facts }));
          deps.memoryProposals.setCardActivityId(pending.id, activityId);
          return;
        }
        const proposal = result.proposedDelegate;
        if (!proposal) return;
        const choice = resolveCliModel(detected, { cli: proposal.cli, model: proposal.model }, modelMemory, deps.cliModels);
        if (!choice) {
          await fx.post(NO_CLI);
          return;
        }
        const pending = deps.proposals.add({
          proposal, conversationId: msg.conversationId, proposedBy: msg.fromName,
          defaultCli: choice.cli, defaultModel: choice.model,
        });
        const projectName = projects.find((p) => p.path === proposal.projectPath)?.name ?? proposal.projectPath;
        const activityId = await fx.postCard(deps.cards.proposalCard({
          proposalId: pending.id, projectName, skillName: proposal.skillName,
          instruction: proposal.instruction, clis: detected,
          models: availableModels(deps.cliModels, detected), defaultCli: choice.cli, defaultModel: choice.model,
        }));
        deps.proposals.setCardActivityId(pending.id, activityId);
      } catch (err) {
        await fx.reply(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async onCardAction(action: CardAction, fx: BotEffects): Promise<void> {
      const { beanAction, proposalId, projectPath } = action.value;
      if (beanAction === "cancel-run") {
        if (!deps.runs.cancel(projectPath ?? "")) await fx.post("Nothing is running in that project.");
        return;
      }
      if (beanAction === "save-note" || beanAction === "cancel-note") {
        await handleNoteAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
      if (beanAction === "save-skill" || beanAction === "cancel-skill") {
        await handleSkillAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
      if (beanAction === "queue-todo" || beanAction === "cancel-todo") {
        await handleTodoAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
      if (beanAction === "save-memories" || beanAction === "cancel-memories") {
        await handleMemoryAction(beanAction, proposalId, action.value.memoryPicks, action.fromName, fx);
        return;
      }
      if (beanAction === "confirm-consolidation" || beanAction === "cancel-consolidation") {
        await handleConsolidationAction(beanAction, proposalId, fx);
        return;
      }
      if (beanAction === "start-live" || beanAction === "cancel-live") {
        if (!proposalId) return;
        const pending = deps.liveSessionProposals.claim(proposalId);
        if (!pending) {
          await fx.post("That live-session proposal expired — ask me to start one again.");
          return;
        }
        if (beanAction === "cancel-live") {
          const projects = await deps.loadProjects();
          const projectName = projects.find((p) => p.path === pending.proposal.projectPath)?.name ?? pending.proposal.projectPath;
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled" }));
          }
          return;
        }
        // The proposal was only offered while live sessions were enabled, but it can sit
        // unclaimed for up to 10 minutes — re-check the gate here, the one place that
        // actually launches the permissions-bypassed process.
        if (!deps.liveSessionsEnabled()) {
          const projects = await deps.loadProjects();
          const projectName = projects.find((p) => p.path === pending.proposal.projectPath)?.name ?? pending.proposal.projectPath;
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: action.fromName, outcome: "cancelled" }));
          }
          await fx.post("Live sessions are disabled — this session wasn't started.");
          return;
        }
        await startLiveSessionAction(pending, action.fromName, action.fromId ?? "", fx);
        return;
      }
      if (!proposalId) return;
      if (beanAction !== "cancel-proposal" && beanAction !== "confirm") return;
      const p = deps.proposals.claim(proposalId);
      if (beanAction === "cancel-proposal") {
        if (p?.cardActivityId !== undefined) {
          const projects = await deps.loadProjects();
          const projectName = projects.find((pr) => pr.path === p.proposal.projectPath)?.name ?? p.proposal.projectPath;
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
}
