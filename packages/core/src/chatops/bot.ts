import { converse, type ConverseDeps } from "../converse.js";
import { extractMemories } from "../memory/extract.js";
import { availableModels } from "../models.js";
import type { Skill, Project } from "../types.js";
import type { Persona } from "../persona.js";
import type { Memory, MemoryCandidate } from "../memory/memory.js";
import type { CliName } from "../launcher.js";
import type { DelegateRequest } from "../delegate.js";
import type { CardBuilders } from "./cards-api.js";
import { formatAmbientBlock, type AmbientMessage } from "./ambient.js";
import { memoryUpdatesFor, resolveCliModel } from "./resolve.js";
import type { ConversationStore } from "./conversation.js";
import type { PendingProposal, ProposalStore } from "./proposals.js";
import type { NoteProposalStore } from "./note-proposals.js";
import type { MemoryProposalStore } from "./memory-proposals.js";
import { retrieveNoteTool, type Note, type NoteDraft } from "../note-store.js";
import type { RunRegistry } from "./runs.js";

export interface IncomingMessage {
  conversationId: string;
  text: string;
  fromId: string;
  fromName: string;
}

export interface CardAction {
  conversationId: string;
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
  runs: RunRegistry;
  proposals: ProposalStore;
  noteProposals: NoteProposalStore;
  /** Persists a confirmed note to ~/.bean/notes (server injects the notes dir). */
  saveNote: (draft: NoteDraft) => Promise<string>;
  /** Reads back saved notes from ~/.bean/notes (server injects the notes dir); backs retrieve_note. */
  loadNotes: () => Promise<Note[]>;
  memoryProposals: MemoryProposalStore;
  /** Persists the full memory list (server injects the memory file path). */
  saveMemories: (memories: Memory[]) => Promise<void>;
  conversations: ConversationStore;
  cards: CardBuilders;
}

const DESKTOP_ONLY =
  "That needs the Bean desktop app — from here I can only chat and run background delegate tasks. Ask me again and I'll run it as one.";
const NO_CLI = "I can't run delegate tasks: neither `claude` nor `opencode` is on this machine's PATH.";

export function buildTeamsBot(deps: TeamsBotDeps): {
  onMessage: (msg: IncomingMessage, fx: BotEffects) => Promise<void>;
  onCardAction: (action: CardAction, fx: BotEffects) => Promise<void>;
} {
  const actions = [retrieveNoteTool(deps.loadNotes)];

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
      const existing = await deps.loadMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = selected.map((c, i) => ({
        id: `${Date.now()}-${i}`, text: c.text, projectPath: c.projectPath, createdAt: now,
      }));
      await deps.saveMemories([...existing, ...additions]);
      await updateTo(resultCard("saved", selected.length));
      await fx.post(`Remembered ${selected.length} fact(s).`);
    } catch (err) {
      await fx.post(`Couldn't save memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    async onMessage(msg: IncomingMessage, fx: BotEffects): Promise<void> {
      try {
        if (msg.text.trim().toLowerCase() === "cancel") {
          const n = deps.runs.cancelAll();
          await fx.reply(n > 0 ? `Cancelled ${n} run(s).` : "Nothing is running.");
          return;
        }
        const [skills, projects, persona, memories, modelMemory] = await Promise.all([
          deps.loadSkills(), deps.loadProjects(), deps.loadPersona(), deps.loadMemories(), deps.loadModelMemory(),
        ]);
        const detected = deps.detectClis();
        let history = deps.conversations.history(msg.conversationId);
        if (fx.fetchRecent) {
          // ponytail: fixed 15-min window; the block carries timestamps so the model can
          // scope "the last 10 minutes" itself — parse the user's timeframe if it matters.
          const ambient = (await fx.fetchRecent(Date.now() - 15 * 60_000)).slice(-50);
          if (ambient.length > 0) {
            history = [{ role: "user", content: formatAmbientBlock(ambient) }, ...history];
          }
        }
        // runAvailable=false: propose_run is never offered here — confirming one couldn't
        // execute anything from Teams/Discord; propose_delegate is the only run path.
        const result = await converse(
          history, msg.text, skills, projects, persona, memories,
          { chat: deps.chat, model: deps.model },
          undefined, actions, undefined, undefined, true, detected, true, false,
        );
        deps.conversations.append(msg.conversationId, { role: "user", content: msg.text });
        if (result.reply) {
          deps.conversations.append(msg.conversationId, { role: "assistant", content: result.reply });
          await fx.reply(result.reply);
        }
        if (result.proposedRun) {
          // A `target: chat` skill runs on Bean's own model: resend the composed prompt
          // through this same conversation (mirrors ChatWindow's confirmProposal). No
          // confirm card — it's just another chat reply, no agent harness or side effects.
          if (result.proposedRun.target === "chat") {
            const run = result.proposedRun;
            const followup = await converse(
              deps.conversations.history(msg.conversationId), run.composedPrompt,
              skills, projects, persona, memories,
              { chat: deps.chat, model: deps.model },
              undefined, actions, undefined, undefined, true, detected, true, false,
            );
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
        const choice = resolveCliModel(detected, { cli: proposal.cli, model: proposal.model }, modelMemory);
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
          models: availableModels(detected), defaultCli: choice.cli, defaultModel: choice.model,
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
      if (beanAction === "save-memories" || beanAction === "cancel-memories") {
        await handleMemoryAction(beanAction, proposalId, action.value.memoryPicks, action.fromName, fx);
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
      );
      if (!choice) {
        await fx.post(NO_CLI);
        return;
      }
      await startRun(p, choice.cli, choice.model, action.fromName, fx);
    },
  };
}
