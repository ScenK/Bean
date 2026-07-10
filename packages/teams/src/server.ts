import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory,
  detectClis, runDelegate,
} from "@bean/core";
import {
  ActivityTypes, CloudAdapter, ConfigurationBotFrameworkAuthentication, ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference, type Activity,
} from "botbuilder";
import express from "express";
import { buildTeamsBot, type BotEffects } from "./bot.js";
import { ConversationStore } from "./conversation.js";
import { ProposalStore } from "./proposals.js";
import { RunRegistry } from "./runs.js";
import { loadTeamsConfig, teamsConfigFile } from "./teams-config.js";

const dir = beanDir();
const teamsConfig = await loadTeamsConfig(teamsConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");

// ConfigurationServiceClientCredentialFactory builds the app-id/password credentials;
// ConfigurationBotFrameworkAuthentication just needs an (empty) options object plus that
// factory — this is the documented botbuilder 4.23 shape, not the brief's indicative one.
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: teamsConfig.botAppId,
  MicrosoftAppPassword: teamsConfig.botAppPassword,
  MicrosoftAppType: "MultiTenant",
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
  loadSkills: () => loadLayeredSkills(skillsDir(projectBeanDir()), skillsDir(dir)),
  loadProjects: () => loadProjects(projectsFile(dir)),
  loadPersona: () => loadPersona(personaFile(dir), personaFile(projectBeanDir())),
  loadMemories: () => loadMemories(memoryFile(dir)),
  loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
  saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
  detectClis: () => clis,
  runs: new RunRegistry(runDelegate),
  proposals: new ProposalStore(),
  conversations: new ConversationStore(),
});

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
    await bot.onMessage(
      { conversationId: a.conversation.id, text, fromId: a.from.id, fromName: a.from.name ?? "someone" },
      fx,
    );
  });
});

app.listen(teamsConfig.port, () => {
  console.log(`@bean/teams listening on :${teamsConfig.port} (clis: ${clis.join(", ") || "none"})`);
});
