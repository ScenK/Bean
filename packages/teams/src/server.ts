import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory,
  detectClis, runDelegate,
  buildTeamsBot, type BotEffects, AmbientStore, ConversationStore, ProposalStore, RunRegistry,
} from "@bean/core";
import {
  ActivityTypes, CloudAdapter, ConfigurationBotFrameworkAuthentication, ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference, type Activity,
} from "botbuilder";
import express from "express";
import { finishedCard, proposalCard, runningCard } from "./cards.js";
import { loadTeamsConfig, teamsConfigFile } from "./teams-config.js";

const dir = beanDir();
const builtinDir = process.env.BEAN_BUILTIN_DIR || projectBeanDir();
const teamsConfig = await loadTeamsConfig(teamsConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");

// ConfigurationServiceClientCredentialFactory builds the app-id/password credentials;
// ConfigurationBotFrameworkAuthentication just needs an (empty) options object plus that
// factory — this is the documented botbuilder 4.23 shape, not the brief's indicative one.
// SingleTenant (not MultiTenant): Azure Bot Service no longer offers "Multi Tenant" as an
// app type for new registrations, so this bot is scoped to the one AAD tenant that owns
// the app registration — teamsConfig.tenantId comes from that registration's Overview page.
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: teamsConfig.botAppId,
  MicrosoftAppPassword: teamsConfig.botAppPassword,
  MicrosoftAppType: "SingleTenant",
  MicrosoftAppTenantId: teamsConfig.tenantId,
});
const auth = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
const adapter = new CloudAdapter(auth);
adapter.onTurnError = async (context, error) => {
  console.error("turn error:", error);
  await context.sendActivity("Something went wrong handling that message.");
};

const clis = detectClis();
const bot = buildTeamsBot({
  chat: makeOpenAIConverse(beanConfig.openaiApiKey),
  model: beanConfig.model,
  loadSkills: () => loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  loadProjects: () => loadProjects(projectsFile(dir)),
  loadPersona: () => loadPersona(personaFile(dir), personaFile(builtinDir)),
  loadMemories: () => loadMemories(memoryFile(dir)),
  loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
  saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
  detectClis: () => clis,
  runs: new RunRegistry(runDelegate),
  proposals: new ProposalStore(),
  conversations: new ConversationStore(),
  cards: { proposalCard, runningCard, finishedCard },
});

// Ambient (non-mention) channel messages only reach /api/messages if the Teams app manifest
// grants the RSC permission ChannelMessage.Read.Group — see packages/teams/README.md.
const ambient = new AmbientStore();

/** True when the message @mentions the bot; personal (1:1) chats always count as addressed. */
function addressedToBot(a: Activity): boolean {
  if (a.conversation.conversationType === "personal") return true;
  return (a.entities ?? []).some(
    (e) => e.type === "mention" && (e as { mentioned?: { id?: string } }).mentioned?.id === a.recipient.id,
  );
}

/** Effects bound to the incoming turn's conversation; posts after the turn ends go
 * through continueConversationAsync (proactive messages need a fresh context). */
function effectsFor(context: TurnContext): BotEffects {
  const ref: Partial<ConversationReference> = TurnContext.getConversationReference(context.activity);
  const proactive = async (fn: (ctx: TurnContext) => Promise<void>): Promise<void> => {
    await adapter.continueConversationAsync(teamsConfig.botAppId, ref, fn);
  };
  return {
    reply: async (text) => { await context.sendActivity({ type: ActivityTypes.Message, text }); },
    post: async (text) => { await proactive(async (ctx) => { await ctx.sendActivity({ type: ActivityTypes.Message, text }); }); },
    postCard: async (card) => {
      const res = await context.sendActivity({
        type: ActivityTypes.Message,
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
      });
      return res?.id ?? "";
    },
    updateCard: async (activityId, card) => {
      await proactive(async (ctx) => {
        await ctx.updateActivity({
          id: activityId,
          type: ActivityTypes.Message,
          conversation: ref.conversation,
          attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
        } as Partial<Activity> as Activity);
      });
    },
  };
}

const app = express();
app.use(express.json());
app.post("/api/messages", (req, res) => {
  void adapter.process(req, res, async (context) => {
    const a = context.activity;
    if (a.type !== ActivityTypes.Message) return;
    const fx = effectsFor(context);
    const value = a.value as Record<string, string> | undefined;
    if (value?.beanAction) {
      await bot.onCardAction(
        { conversationId: a.conversation.id, fromName: a.from.name ?? "someone", value },
        fx,
      );
      return;
    }
    const text = TurnContext.removeRecipientMention(a)?.trim() ?? a.text?.trim() ?? "";
    if (!text) return;
    if (!addressedToBot(a)) {
      // Not for Bean — remember it as context for a later mention, but don't reply.
      ambient.append(a.conversation.id, { fromName: a.from.name ?? "someone", text, at: Date.now() });
      return;
    }
    fx.fetchRecent = async (sinceMs) => ambient.since(a.conversation.id, sinceMs);
    await context.sendActivity({ type: ActivityTypes.Typing });
    // Teams clears the typing indicator quickly; resend while onMessage is still working.
    const typing = setInterval(() => { void context.sendActivity({ type: ActivityTypes.Typing }); }, 5000);
    try {
      await bot.onMessage(
        { conversationId: a.conversation.id, text, fromId: a.from.id, fromName: a.from.name ?? "someone" },
        fx,
      );
    } finally {
      clearInterval(typing);
    }
  });
});

app.listen(teamsConfig.port, () => {
  console.log(`@bean/teams listening on :${teamsConfig.port} (clis: ${clis.join(", ") || "none"})`);
});
