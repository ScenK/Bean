import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, dbFile, modelMemoryFile, routinesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, searchNotes, saveMemories, appendMemories,
  detectClis, runDelegate, claimOutbox, outboxDir, saveSkill, addTodo, loadRoutines, resolveTodoRoutine,
  buildTeamsBot, exitWhenOrphaned, ConversationStore, MemoryProposalStore, NoteProposalStore, ProposalStore,
  ConsolidationProposalStore, RunRegistry, SkillProposalStore, TodoProposalStore, type BotEffects,
} from "@bean/core";
import {
  ChannelType, Client, GatewayIntentBits, Partials,
  type Interaction, type Message, type MessageCreateOptions, type TextBasedChannel,
} from "discord.js";
import { chunkText } from "./chunk.js";
import { discordCards } from "./components.js";
import { discordConfigFile, loadDiscordConfig } from "./discord-config.js";

const dir = beanDir();
const builtinDir = process.env.BEAN_BUILTIN_DIR || projectBeanDir();
const discordConfig = await loadDiscordConfig(discordConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");

const clis = detectClis();
const runs = new RunRegistry(runDelegate, { dir, botKind: "discord" });
// Kept as its own reference (not just inline in buildTeamsBot's deps) so the outbox delivery
// loop below can append an interrupted-run notice to the same history bot.onMessage reads —
// otherwise a later "retry" in this channel has no idea what it's retrying.
const conversations = new ConversationStore(dbFile(dir));
const bot = buildTeamsBot({
  chat: makeOpenAIConverse(beanConfig.openaiApiKey),
  model: beanConfig.model,
  loadSkills: () => loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  loadProjects: () => loadProjects(projectsFile(dir)),
  loadPersona: () => loadPersona(personaFile(dir), personaFile(builtinDir)),
  loadMemories: () => loadMemories(dbFile(dir)),
  loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
  saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
  detectClis: () => clis,
  runs,
  proposals: new ProposalStore(),
  noteProposals: new NoteProposalStore(),
  saveNote: (draft) => saveNote(dbFile(dir), draft),
  searchNotes: (query) => searchNotes(dbFile(dir), query),
  todoProposals: new TodoProposalStore(),
  queueTodo: async (routine, text) => {
    resolveTodoRoutine(await loadRoutines(routinesDir(dir)), routine);
    await addTodo(dbFile(dir), routine, text);
  },
  listTodoRoutines: async () => (await loadRoutines(routinesDir(dir))).filter((r) => r.todoDriven).map((r) => r.name),
  skillProposals: new SkillProposalStore(),
  saveSkill: (name, body) => saveSkill(skillsDir(dir), name, body),
  memoryProposals: new MemoryProposalStore(),
  appendMemories: (m) => appendMemories(dbFile(dir), m),
  saveMemories: (m) => saveMemories(dbFile(dir), m),
  consolidationProposals: new ConsolidationProposalStore(),
  conversations,
  cards: discordCards,
});

// Partials.Channel is REQUIRED for DM message events in discord.js v14 (DM channels
// arrive uncached); Message Content intent must also be enabled in the developer portal.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Latest select-menu choices per proposal message id — Discord sends each select change
// as its own interaction, so the values must be cached until the Run button is pressed.
// Entries die with the proposal (deleted on confirm/cancel).
const selections = new Map<string, { cli?: string; model?: string; memoryPicks?: string[] }>();

const allowed = (userId: string): boolean => discordConfig.allowedUserIds.includes(userId);

function effectsFor(channel: TextBasedChannel, triggeringMessageId?: string): BotEffects {
  const send = async (options: string | MessageCreateOptions): Promise<Message> => {
    if (!("send" in channel)) throw new Error("channel is not sendable");
    return channel.send(options as MessageCreateOptions);
  };
  return {
    reply: async (text) => { for (const c of chunkText(text)) await send(c); },
    post: async (text) => { for (const c of chunkText(text)) await send(c); },
    postCard: async (card) => (await send(card as MessageCreateOptions)).id,
    updateCard: async (activityId, card) => {
      if (!("messages" in channel)) return;
      const msg = await channel.messages.fetch(activityId);
      await msg.edit(card as Parameters<Message["edit"]>[0]);
    },
    fetchRecent: async (sinceMs) => {
      if (!("messages" in channel)) return [];
      const fetched = await channel.messages.fetch({ limit: 50 });
      return [...fetched.values()]
        // Messages addressed to Bean are already in the conversation history — only
        // genuine bystander chatter counts as ambient.
        .filter((m) =>
          m.createdTimestamp >= sinceMs && !m.author.bot && m.id !== triggeringMessageId &&
          m.content && !m.mentions.users.has(client.user?.id ?? ""))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => ({ fromName: m.author.displayName, text: m.content, at: m.createdTimestamp }));
    },
  };
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !allowed(message.author.id)) return;
    const isDm = message.channel.type === ChannelType.DM;
    // Only an explicit address (DM, @mention, reply-to-Bean) gets a turn. Naming the bot in
    // passing ("we should add x to bean") is about Bean, not to it — it stays ambient context.
    const addressed =
      isDm ||
      message.mentions.users.has(client.user?.id ?? "") ||
      message.mentions.repliedUser?.id === client.user?.id;
    if (!addressed) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user?.id ?? ""}>`, "g"), "").trim();
    if (!text) return;
    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    // Discord's typing indicator lasts ~10s; refresh it while onMessage is still working.
    const typing = "sendTyping" in message.channel
      ? setInterval(() => message.channel.sendTyping().catch(() => {}), 8000)
      : undefined;
    try {
      await bot.onMessage(
        { conversationId: message.channelId, text, fromId: message.author.id, fromName: message.author.displayName },
        effectsFor(message.channel, message.id),
      );
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (!allowed(interaction.user.id)) return;
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const match = /^bean:([a-z-]+):(.*)$/.exec(interaction.customId);
    if (!match?.[1] || match[2] === undefined) return;
    const [, action, payload] = match;
    await interaction.deferUpdate(); // ack within Discord's 3s window before slow work

    if (interaction.isStringSelectMenu()) {
      const sel = selections.get(interaction.message.id) ?? {};
      if (action === "cli") sel.cli = interaction.values[0];
      if (action === "model") sel.model = interaction.values[0];
      if (action === "pick-memories") sel.memoryPicks = interaction.values;
      selections.set(interaction.message.id, sel);
      return;
    }

    if (!interaction.channel) return;
    const fx = effectsFor(interaction.channel);
    if (action === "cancel-run") {
      await bot.onCardAction(
        { conversationId: interaction.channelId, fromName: interaction.user.displayName, value: { beanAction: "cancel-run", projectPath: payload } },
        fx,
      );
      return;
    }
    const sel = selections.get(interaction.message.id) ?? {};
    selections.delete(interaction.message.id);
    await bot.onCardAction(
      {
        conversationId: interaction.channelId,
        fromName: interaction.user.displayName,
        value: { beanAction: action, proposalId: payload, cli: sel.cli, model: sel.model, memoryPicks: sel.memoryPicks },
      },
      fx,
    );
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

client.on("error", (err) => console.error("client error:", err));

// chatopsServers.stop() (packages/app/src/chatops-servers.ts) sends SIGTERM with no other
// warning — mark any in-flight run interrupted (durable outbox notice to its conversation)
// before this process disappears, instead of just dying mid-run with the requester left hanging.
process.on("SIGTERM", () => {
  runs.interruptAll(); // synchronous — see its doc comment; safe to exit right after
  process.exit(0);
});

client.once("clientReady", () => {
  console.log(`@bean/discord logged in as ${client.user?.tag} (clis: ${clis.join(", ") || "none"})`);
});

// Routine digests: the main app enqueues outbox files; deliver them to their channel.
const OUTBOX_POLL_MS = 5_000;
setInterval(() => {
  void (async () => {
    for (const msg of await claimOutbox(outboxDir(beanDir()), "discord")) {
      // displayBody present = an interrupted-run notice: msg.body carries the full instruction
      // (needed below so a later "retry" has context), too long to post as-is — show the short
      // version instead. Absent for plain messages (routine digests), which already are the
      // display text.
      const text = msg.displayBody ?? (msg.title ? `**${msg.title}**\n${msg.body}` : msg.body);
      if (!msg.channel) {
        // No channel = DM every allowed user directly (the default delivery mode).
        for (const userId of discordConfig.allowedUserIds) {
          try {
            const user = await client.users.fetch(userId);
            for (const chunk of chunkText(text)) await user.send(chunk);
          } catch (err) {
            console.error(`outbox: discord DM to ${userId} failed`, err);
          }
        }
        continue;
      }
      try {
        const channel = await client.channels.fetch(msg.channel);
        if (!channel?.isTextBased() || !("send" in channel)) {
          console.error(`outbox: discord channel ${msg.channel} not sendable`);
          continue;
        }
        for (const chunk of chunkText(text)) await channel.send(chunk);
        if (msg.displayBody) conversations.append(msg.channel, { role: "assistant", content: msg.body });
      } catch (err) {
        console.error("outbox: discord send failed", err);
      }
    }
  })();
}, OUTBOX_POLL_MS);

// Die with the desktop app that spawned us — see exitWhenOrphaned's doc comment. Discord
// binds no port, so a stale orphan doesn't announce itself with EADDRINUSE: it just stays
// logged in and answers alongside the new one.
exitWhenOrphaned();

await client.login(discordConfig.botToken);
