import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, dbFile, modelMemoryFile, routinesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, searchNotes, saveMemories, appendMemories,
  detectClis, runDelegate, claimOutbox, outboxDir, saveSkill, addTodo, loadRoutines, resolveTodoRoutine,
  buildTeamsBot, exitWhenOrphaned, ConversationStore, MemoryProposalStore, NoteProposalStore, ProposalStore,
  ConsolidationProposalStore, RunRegistry, SkillProposalStore, TodoProposalStore, type BotEffects, loadCliModels, clisFile,
  LiveSessionProposalStore, LiveSessionRegistry,
} from "@bean/core";
import {
  ApplicationCommandOptionType, ChannelType, Client, GatewayIntentBits, Partials,
  type ApplicationCommandDataResolvable,
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

const clis = detectClis().filter((c) => !beanConfig.disabledClis.includes(c));
const cliModels = await loadCliModels(clisFile(builtinDir), clisFile(dir));
const runs = new RunRegistry(runDelegate, { dir, botKind: "discord" });
// Kept as its own reference (not just inline in buildTeamsBot's deps) so the outbox delivery
// loop below can append an interrupted-run notice to the same history bot.onMessage reads —
// otherwise a later "retry" in this channel has no idea what it's retrying.
const conversations = new ConversationStore(dbFile(dir));
const liveSessions = new LiveSessionRegistry(undefined, { dir });
// Hoisted (not inline in deps) so the /live-session card's project/model dropdowns and the
// edit-prompt modal can read and mutate the pending proposal before Start claims it.
const liveSessionProposals = new LiveSessionProposalStore();
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
  cliModels,
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
  liveSessions,
  liveSessionProposals,
  // Always on for Discord (no `liveSessions` config opt-in) — only gated by claude being on
  // PATH, since the live-session engine is claude-specific. Still confirm-first via the card.
  liveSessionsEnabled: () => clis.includes("claude"),
  cards: discordCards,
  systemControlsEnabled: () => beanConfig.systemControls,
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

// Rebuild the live-session proposal card from the current (possibly edited) proposal — used to
// re-render in place after the Edit-prompt modal changes the text.
async function liveSessionCardFor(
  proposalId: string,
  proposal: { projectPath: string; instruction: string; model?: string; skillName?: string; steering?: "open" | "restricted" },
): Promise<object> {
  const [projects, skills] = await Promise.all([
    loadProjects(projectsFile(dir)),
    loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  ]);
  const projectName = projects.find((p) => p.path === proposal.projectPath)?.name ?? proposal.projectPath;
  const models = (cliModels.find((e) => e.provider === "claude")?.models ?? []).map((id) => ({ id, label: id.split("/").pop() || id }));
  return discordCards.liveSessionProposalCard({
    proposalId, projectName, instruction: proposal.instruction, model: proposal.model, skillName: proposal.skillName,
    steering: proposal.steering,
    projects: projects.map((p) => ({ name: p.name, path: p.path })), models,
    skills: skills.filter((s) => !s.hidden).map((s) => ({ name: s.name })), clis: clis.filter((c) => c === "claude"),
  });
}

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
    if (message.author.bot) return;
    // A live session already running in this channel is itself the authorization boundary
    // for steering it — anyone who can post in a channel someone else bound a session in can
    // send it a turn or say `stop`, allowlisted or not (this is the whole point of war-room,
    // whole-channel steering). Outside an active session, allowedUserIds still gates all
    // normal chat with Bean exactly as before.
    const capturing = liveSessions.has(message.channelId);
    if (!capturing && !allowed(message.author.id)) return;
    const isDm = message.channel.type === ChannelType.DM;
    // Only an explicit address (DM, @mention, reply-to-Bean) gets a turn. Naming the bot in
    // passing ("we should add x to bean") is about Bean, not to it — it stays ambient context.
    const addressed =
      isDm ||
      message.mentions.users.has(client.user?.id ?? "") ||
      message.mentions.repliedUser?.id === client.user?.id;
    if (!addressed && !capturing) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user?.id ?? ""}>`, "g"), "").trim();
    if (!text) return;
    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    // Discord's typing indicator lasts ~10s; refresh it while onMessage is still working.
    const typing = "sendTyping" in message.channel
      ? setInterval(() => message.channel.sendTyping().catch(() => {}), 8000)
      : undefined;
    try {
      await bot.onMessage(
        {
          conversationId: message.channelId, text,
          fromId: message.author.id, fromName: message.author.displayName,
          // Everyone @mentioned except Bean — feeds the live-session `+driver`/`-driver` commands.
          mentionedIds: [...message.mentions.users.keys()].filter((id) => id !== client.user?.id),
        },
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
    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.user.id)) {
        await interaction.reply({ content: "You're not on this bot's allow-list.", ephemeral: true });
        return;
      }
      const channelId = interaction.channelId;
      if (interaction.commandName === "new") {
        conversations.clear(channelId);
        conversations.setAmbientCutoff(channelId, Date.now()); // fence pre-reset chatter out of ambient
        await interaction.reply({ content: "Fresh start — I've cleared this conversation's context.", ephemeral: true });
        return;
      }
      if (interaction.commandName === "cancel") {
        const n = runs.cancelAll();
        await interaction.reply({ content: n > 0 ? `Cancelled ${n} run(s).` : "Nothing is running.", ephemeral: true });
        return;
      }
      if (interaction.commandName === "stop") {
        // Same steering gate as a plain `stop` message: in a restricted session only the
        // starter/co-drivers may end it, not any allow-listed bystander.
        if (liveSessions.has(channelId) && !liveSessions.canSteer(channelId, interaction.user.id)) {
          await interaction.reply({ content: "Only the session starter or a co-driver can stop this live session.", ephemeral: true });
          return;
        }
        const stopped = liveSessions.stop(channelId);
        await interaction.reply({ content: stopped ? "Stopping the live session." : "No live session running in this channel.", ephemeral: true });
        return;
      }
      if (interaction.commandName === "live-session" && interaction.channel) {
        await interaction.deferReply({ ephemeral: true }); // proposeLiveSession posts to the channel; ack within 3s
        const reply = await bot.proposeLiveSession(
          { conversationId: channelId, instruction: interaction.options.getString("prompt", true), proposedBy: interaction.user.displayName },
          effectsFor(interaction.channel),
        );
        await interaction.editReply(reply);
      }
      return;
    }
    // Edit-prompt modal submit: apply the new text, then re-render the card in place.
    if (interaction.isModalSubmit()) {
      if (!allowed(interaction.user.id)) return;
      const m = /^bean:live-editsubmit:(.*)$/.exec(interaction.customId);
      if (!m?.[1] || !interaction.isFromMessage()) return;
      const proposalId = m[1];
      const text = interaction.fields.getTextInputValue("prompt").trim();
      if (text) liveSessionProposals.update(proposalId, { instruction: text });
      const pending = liveSessionProposals.get(proposalId);
      if (!pending) { await interaction.deferUpdate(); return; }
      await interaction.update(await liveSessionCardFor(proposalId, pending.proposal));
      return;
    }
    // Edit-prompt button: open the modal prefilled with the current prompt. MUST run before any
    // deferUpdate below — showModal has to be the interaction's first response.
    if (interaction.isButton() && interaction.customId.startsWith("bean:live-edit:")) {
      if (!allowed(interaction.user.id)) return;
      const proposalId = interaction.customId.slice("bean:live-edit:".length);
      const pending = liveSessionProposals.get(proposalId);
      if (!pending) { await interaction.reply({ content: "That live-session proposal expired.", ephemeral: true }); return; }
      await interaction.showModal({
        custom_id: `bean:live-editsubmit:${proposalId}`,
        title: "Edit the prompt",
        components: [{ type: 1, components: [{
          type: 4, custom_id: "prompt", label: "Prompt sent to the agent",
          style: 2, required: true, max_length: 4000, value: pending.proposal.instruction.slice(0, 4000),
        }] }],
      });
      return;
    }
    if (!allowed(interaction.user.id)) return;
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const match = /^bean:([a-z-]+):(.*)$/.exec(interaction.customId);
    if (!match?.[1] || match[2] === undefined) return;
    const [, action, payload] = match;
    await interaction.deferUpdate(); // ack within Discord's 3s window before slow work

    if (interaction.isStringSelectMenu()) {
      // Live-session project/model dropdowns write straight to the pending proposal (Start reads
      // it), unlike the delegate card's cli/model which stay in the per-message selections map.
      const liveValue = interaction.values[0];
      if (action === "live-project" && liveValue) { liveSessionProposals.update(payload, { projectPath: liveValue }); return; }
      if (action === "live-model" && liveValue) { liveSessionProposals.update(payload, { model: liveValue }); return; }
      if (action === "live-skill" && liveValue) { liveSessionProposals.update(payload, { skillName: liveValue === "__none__" ? undefined : liveValue }); return; }
      if (action === "live-cli") return; // claude-only today; the dropdown is informational
      const sel = selections.get(interaction.message.id) ?? {};
      if (action === "cli") sel.cli = interaction.values[0];
      if (action === "model") sel.model = interaction.values[0];
      if (action === "pick-memories") sel.memoryPicks = interaction.values;
      selections.set(interaction.message.id, sel);
      return;
    }

    // War-room ⇄ restricted toggle on the live-session card: flip the pending proposal and
    // re-render in place. Pre-launch config, so no session-owner check — just the allow-list.
    if (action === "live-mode") {
      const pending = liveSessionProposals.get(payload);
      if (pending) {
        const next = pending.proposal.steering === "open" ? "restricted" : "open";
        liveSessionProposals.update(payload, { steering: next });
        await interaction.editReply(await liveSessionCardFor(payload, { ...pending.proposal, steering: next }));
      }
      return;
    }
    if (!interaction.channel) return;
    const fx = effectsFor(interaction.channel);
    if (action === "cancel-run") {
      await bot.onCardAction(
        { conversationId: interaction.channelId, fromId: interaction.user.id, fromName: interaction.user.displayName, value: { beanAction: "cancel-run", projectPath: payload } },
        fx,
      );
      return;
    }
    const sel = selections.get(interaction.message.id) ?? {};
    selections.delete(interaction.message.id);
    await bot.onCardAction(
      {
        conversationId: interaction.channelId,
        fromId: interaction.user.id,
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
  // forceKillAll(), not stopAll(): stop()'s graceful SIGTERM-then-escalate dance schedules its
  // SIGKILL fallback on a setTimeout that would never fire before process.exit below runs,
  // leaving a permissions-bypassed child orphaned if it doesn't honor SIGTERM promptly.
  liveSessions.forceKillAll();
  process.exit(0);
});

client.once("clientReady", async () => {
  console.log(`@bean/discord logged in as ${client.user?.tag} (clis: ${clis.join(", ") || "none"})`);
  // Control commands map to Bean's existing text commands; /live-session is added only when
  // usable (config flag + claude on PATH). Project/model/skill are picked on its card, so the
  // command itself carries just the opening prompt.
  const liveEnabled = clis.includes("claude");
  const liveCmd: ApplicationCommandDataResolvable = {
    name: "live-session",
    description: "Start a chat-bridged live coding session",
    dmPermission: true,
    options: [
      { type: ApplicationCommandOptionType.String, name: "prompt", description: "What the agent should start on (editable before you Start)", required: true },
    ],
  };
  const commands: ApplicationCommandDataResolvable[] = [
    { name: "new", description: "Clear this conversation's context (fresh start)", dmPermission: true },
    { name: "cancel", description: "Cancel any running background task(s)", dmPermission: true },
    { name: "stop", description: "Stop the live session bound to this channel", dmPermission: true },
    ...(liveEnabled ? [liveCmd] : []),
  ];
  const app = client.application;
  if (!app) return;
  // guildId set → register to that one server (instant); else global (all guilds Bean is in,
  // ~1h first propagation). Registration silently no-ops if the bot lacks the
  // `applications.commands` OAuth scope — re-invite with that scope if commands never appear.
  if (discordConfig.guildId) {
    await app.commands.set(commands, discordConfig.guildId);
    console.log(`@bean/discord registered ${commands.length} slash command(s) to guild ${discordConfig.guildId}`);
  } else {
    await app.commands.set(commands);
    console.log(`@bean/discord registered ${commands.length} global slash command(s) (first propagation can take ~1h)`);
  }
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
