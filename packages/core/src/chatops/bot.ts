import { converse, type ConverseDeps } from "../converse.js";
import { availableModels } from "../models.js";
import type { Skill, Project } from "../types.js";
import type { Persona } from "../persona.js";
import type { Memory } from "../memory/memory.js";
import type { CliName } from "../launcher.js";
import type { DelegateRequest } from "../delegate.js";
import type { CardBuilders } from "./cards-api.js";
import { formatAmbientBlock, type AmbientMessage } from "./ambient.js";
import { memoryUpdatesFor, resolveCliModel } from "./resolve.js";
import type { ConversationStore } from "./conversation.js";
import type { PendingProposal, ProposalStore } from "./proposals.js";
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
  value: { beanAction?: string; proposalId?: string; projectPath?: string; cli?: string; model?: string };
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
  conversations: ConversationStore;
  cards: CardBuilders;
}

const DESKTOP_ONLY = "That needs the Bean desktop app — I can only chat and run delegate tasks from Teams.";
const NO_CLI = "I can't run delegate tasks: neither `claude` nor `opencode` is on this machine's PATH.";

export function buildTeamsBot(deps: TeamsBotDeps): {
  onMessage: (msg: IncomingMessage, fx: BotEffects) => Promise<void>;
  onCardAction: (action: CardAction, fx: BotEffects) => Promise<void>;
} {
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
    const started = deps.runs.start(req, {
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
    });
    if (!started) {
      await updateTo(deps.cards.finishedCard({ projectName, instruction: p.proposal.instruction, startedBy, outcome: "cancelled" }));
      await fx.post("A run is already going in that project — wait for it or cancel it first.");
      return;
    }
    await updateTo(deps.cards.runningCard({ projectName, instruction: p.proposal.instruction, startedBy, projectPath: req.projectPath }));
    const memory = await deps.loadModelMemory();
    await deps.saveModelMemory({ ...memory, ...memoryUpdatesFor({ cli, model }) });
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
        const result = await converse(
          history, msg.text, skills, projects, persona, memories,
          { chat: deps.chat, model: deps.model },
          undefined, [], undefined, undefined, true, detected,
        );
        deps.conversations.append(msg.conversationId, { role: "user", content: msg.text });
        if (result.reply) {
          deps.conversations.append(msg.conversationId, { role: "assistant", content: result.reply });
          await fx.reply(result.reply);
        }
        if (result.proposedRun || result.proposedNote) {
          await fx.post(DESKTOP_ONLY);
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
