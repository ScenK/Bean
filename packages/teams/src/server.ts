import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile, notesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, loadNotes, saveMemories,
  detectClis, runDelegate, claimOutbox, outboxDir,
  buildTeamsBot, mentionsBotName, type BotEffects, AmbientStore, ConversationStore, MemoryProposalStore, NoteProposalStore, ProposalStore, RunRegistry,
} from "@bean/core";
import {
  ActivityTypes, CloudAdapter, ConfigurationBotFrameworkAuthentication, ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference, type Activity,
} from "botbuilder";
import express from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finishedCard, memoryProposalCard, memoryResultCard, noteProposalCard, noteResultCard, proposalCard, runningCard } from "./cards.js";
import { loadTeamsConfig, teamsConfigFile } from "./teams-config.js";

const dir = beanDir();
const builtinDir = process.env.BEAN_BUILTIN_DIR || projectBeanDir();
const teamsConfig = await loadTeamsConfig(teamsConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");

// Proactive delivery (outbox digests) needs a ConversationReference per Teams conversation;
// persisted so a restart doesn't drop routines until someone mentions the bot again.
const conversationRefsFile = join(beanDir(), "teams-conversations.json");
let conversationRefs: Record<string, Partial<ConversationReference>> = {};
try {
  conversationRefs = JSON.parse(await readFile(conversationRefsFile, "utf8")) as typeof conversationRefs;
} catch { /* first run */ }

async function rememberConversation(ref: Partial<ConversationReference>): Promise<void> {
  const id = ref.conversation?.id;
  if (!id || conversationRefs[id]) return;
  conversationRefs[id] = ref;
  await mkdir(dirname(conversationRefsFile), { recursive: true });
  await writeFile(conversationRefsFile, JSON.stringify(conversationRefs, null, 2) + "\n", "utf8");
}

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
const runs = new RunRegistry(runDelegate, { dir, botKind: "teams" });
// Kept as its own reference (not just inline in buildTeamsBot's deps) so the outbox delivery
// loop below can append an interrupted-run notice to the same history bot.onMessage reads —
// otherwise a later "retry" in this conversation has no idea what it's retrying.
const conversations = new ConversationStore();
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
  runs,
  proposals: new ProposalStore(),
  noteProposals: new NoteProposalStore(),
  saveNote: (draft) => saveNote(notesDir(dir), draft),
  loadNotes: () => loadNotes(notesDir(dir)),
  memoryProposals: new MemoryProposalStore(),
  saveMemories: (m) => saveMemories(memoryFile(dir), m),
  conversations,
  cards: { proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, memoryProposalCard, memoryResultCard },
});

// chatopsServers.stop() (packages/app/src/chatops-servers.ts) sends SIGTERM with no other
// warning — mark any in-flight run interrupted (durable outbox notice to its conversation)
// before this process disappears, instead of just dying mid-run with the requester left hanging.
process.on("SIGTERM", () => {
  runs.interruptAll(); // synchronous — see its doc comment; safe to exit right after
  process.exit(0);
});

// Ambient (non-mention) channel messages only reach /api/messages if the Teams app manifest
// grants the RSC permission ChannelMessage.Read.Group — see packages/teams/README.md.
const ambient = new AmbientStore();

/** True when the message @mentions the bot or names it in the text; personal (1:1)
 * chats always count as addressed. Untagged channel messages only arrive at all
 * with the RSC permission above. */
function addressedToBot(a: Activity): boolean {
  if (a.conversation.conversationType === "personal") return true;
  const mentioned = (a.entities ?? []).some(
    (e) => e.type === "mention" && (e as { mentioned?: { id?: string } }).mentioned?.id === a.recipient.id,
  );
  return mentioned || mentionsBotName(a.text ?? "", a.recipient.name ?? "");
}

/** Effects bound to the incoming turn's conversation; posts after the turn ends go
 * through continueConversationAsync (proactive messages need a fresh context). */
function effectsFor(context: TurnContext): BotEffects {
  const ref: Partial<ConversationReference> = TurnContext.getConversationReference(context.activity);
  void rememberConversation(ref);
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
      const memoryPicks = value.beanAction === "save-memories"
        ? Object.keys(value).filter((k) => /^fact-\d+$/.test(k) && value[k] === "true").map((k) => k.slice(5))
        : undefined;
      await bot.onCardAction(
        {
          conversationId: a.conversation.id,
          fromName: a.from.name ?? "someone",
          value: {
            beanAction: value.beanAction, proposalId: value.proposalId, projectPath: value.projectPath,
            cli: value.cli, model: value.model, memoryPicks,
          },
        },
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

// Routine digests: the main app enqueues outbox files; deliver them via a proactive message.
const OUTBOX_POLL_MS = 5_000;
setInterval(() => {
  void (async () => {
    for (const msg of await claimOutbox(outboxDir(beanDir()), "teams")) {
      // displayBody present = an interrupted-run notice: msg.body carries the full instruction
      // (needed below so a later "retry" has context), too long to post as-is — show the short
      // version instead. Absent for plain messages (routine digests), which already are the
      // display text.
      const text = msg.displayBody ?? (msg.title ? `**${msg.title}**\n\n${msg.body}` : msg.body);
      // No channel = DM the user directly: every personal (1:1) conversation we've seen so
      // far (the default delivery mode). A specific channel targets one known conversation.
      const targets = msg.channel
        ? (conversationRefs[msg.channel] ? [conversationRefs[msg.channel]!] : [])
        : Object.values(conversationRefs).filter((r) => r.conversation?.conversationType === "personal");
      if (targets.length === 0) {
        console.error(msg.channel
          ? `outbox: unknown teams conversation ${msg.channel} — message dropped (mention the bot there once first)`
          : "outbox: no known personal Teams conversation yet — message dropped (DM the bot once first)");
        continue;
      }
      let delivered = false;
      for (const ref of targets) {
        try {
          await adapter.continueConversationAsync(teamsConfig.botAppId, ref, async (context) => {
            await context.sendActivity(text);
          });
          delivered = true;
        } catch (err) {
          console.error("outbox: teams send failed", err);
        }
      }
      if (delivered && msg.displayBody && msg.channel) conversations.append(msg.channel, { role: "assistant", content: msg.body });
    }
  })();
}, OUTBOX_POLL_MS);
