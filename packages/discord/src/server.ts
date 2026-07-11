import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile, notesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote,
  detectClis, runDelegate,
  buildTeamsBot, ConversationStore, NoteProposalStore, ProposalStore, RunRegistry, type BotEffects,
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
  noteProposals: new NoteProposalStore(),
  saveNote: (draft) => saveNote(notesDir(dir), draft),
  conversations: new ConversationStore(),
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
const selections = new Map<string, { cli?: string; model?: string }>();

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
        .filter((m) => m.createdTimestamp >= sinceMs && !m.author.bot && m.id !== triggeringMessageId && m.content)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((m) => ({ fromName: m.author.displayName, text: m.content, at: m.createdTimestamp }));
    },
  };
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !allowed(message.author.id)) return;
    const isDm = message.channel.type === ChannelType.DM;
    if (!isDm && !message.mentions.users.has(client.user?.id ?? "")) return;
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
        value: { beanAction: action, proposalId: payload, cli: sel.cli, model: sel.model },
      },
      fx,
    );
  } catch (err) {
    console.error("interactionCreate error:", err);
  }
});

client.on("error", (err) => console.error("client error:", err));

client.once("clientReady", () => {
  console.log(`@bean/discord logged in as ${client.user?.tag} (clis: ${clis.join(", ") || "none"})`);
});
await client.login(discordConfig.botToken);
