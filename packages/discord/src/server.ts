import {
  beanDir, ensurePrivateBeanDir, scratchDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, dbFile, modelMemoryFile, routinesDir, remindersFile,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, saveNoteImage, searchNotes, archiveNote, restoreNoteOutcome, NoteArchiveProposalStore, appendMemories, deleteMemories, shareMemory,
  detectClis, type CliName, runDelegate, drainOutbox, recoverOutbox, OUTBOX_MAX_ATTEMPTS, type OutboxMessage, enqueueOutbox, outboxDir, saveSkill, addTodo, listOpenTodos, cancelPendingTodo, loadRoutines, memberTodoEligible, resolveTodoRoutine, saveRoutine, createRoutine,
  buildTeamsBot, exitWhenOrphaned, ConversationStore, ConversationCatalog, type ConversationPlace, maybeCompact, NoteProposalStore, ProposalStore,
  RunRegistry, parentActivitySink, SkillProposalStore, TodoProposalStore, type BotEffects, loadCliModels, clisFile,
  LiveSessionProposalStore, type PendingLiveSession, isLiveCli, LiveSessionRegistry, findDelegateRun, availableModels, MAX_INSTRUCTION_CHARS, type PendingProposal, type ProposedLiveSession, imagesDir, threadTitle, makeOpenAIImageGen, makeOpenAISpeak, makeOpenAITranscribe, MAX_IMAGES_PER_MESSAGE, SUPPORTED_IMAGE_MIMES, type ImageAttachment,
  makeRoles, makeChatter, makeTurnCap, makeChunkGroups, localDay, localTimeZone, DAILY_TURN_CAP, atLeast, cardActionNeeds, cardTapRefusal, dmAllowed, parseRoleCommand, parseRoutineCommand, parseChatterCommand, RoutineProposalStore, type Role,
} from "@bean/core";
import {
  ChannelType, Client, GatewayIntentBits, MessageReferenceType, Partials, PermissionFlagsBits, ThreadAutoArchiveDuration,
  type Interaction, type Message, type MessageCreateOptions, type MessageSnapshot, type TextBasedChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { sendChunks } from "./chunk.js";
import { discordCards } from "./components.js";
import { deliverOutboxDm } from "./outbox-dm.js";
import { resolveRepliedTo, type RefMessage } from "./replied-to.js";
import { discordConfigFile, loadDiscordConfig } from "./discord-config.js";
import { headlessRoutinesOn, startHeadlessRoutines, tzProblem } from "./headless-routines.js";
import { answerSlash, slashCommands, slashMessage } from "./slash.js";

const dir = beanDir();
ensurePrivateBeanDir(dir);
const builtinDir = process.env.BEAN_BUILTIN_DIR || projectBeanDir();
const discordConfig = await loadDiscordConfig(discordConfigFile(dir));
const beanConfig = await loadConfig(configFile(dir), dir);
if (!beanConfig.openaiApiKey) throw new Error("openaiApiKey missing in ~/.bean/config.json");
// Headless routines (no desktop app): this process schedules them. Checked before anything starts.
const headless = headlessRoutinesOn(process.env);
const tzError = headless ? tzProblem(process.env) : undefined;
if (tzError) {
  console.error(tzError);
  process.exit(1);
}
let stopRoutines: (() => Promise<void>) | undefined;

// Re-scanned per call so a CLI installed after the bot started is picked up.
const clis = (): CliName[] => detectClis().filter((c) => !beanConfig.disabledClis.includes(c));
const cliModels = await loadCliModels(clisFile(builtinDir), clisFile(dir));
const runs = new RunRegistry(runDelegate, { dir, botKind: "discord", onActivity: parentActivitySink });
// Kept as its own reference (not just inline in buildTeamsBot's deps) so the outbox delivery
// loop below can append an interrupted-run notice to the same history bot.onMessage reads —
// otherwise a later "retry" in this channel has no idea what it's retrying.
// Hoisted out of the bot deps so the outbox loop's maybeCompact can reuse the same client.
const converseChat = makeOpenAIConverse(beanConfig.openaiApiKey, beanConfig.reasoningEffort);
const conversations = new ConversationStore(dbFile(dir));
const noteProposals = new NoteProposalStore();
const liveSessions = new LiveSessionRegistry(undefined, { dir, onActivity: parentActivitySink, surface: "discord" });
// Hoisted (not inline in deps) so the /live-session card's project/model dropdowns and the
// edit-prompt modal can read and mutate the pending proposal before Start claims it.
const liveSessionProposals = new LiveSessionProposalStore();
// Hoisted for the same reason: the delegate card's Edit-prompt modal edits the pending proposal
// before Run claims it.
const proposals = new ProposalStore();
// Hosts delegates not tied to a project (a Jira ticket, research); spawn needs the cwd to exist.
const scratchPath = scratchDir(dir);
mkdirSync(scratchPath, { recursive: true });
const roles = makeRoles({
  dbPath: dbFile(dir), surface: "discord",
  ownerId: discordConfig.ownerId, ownerName: discordConfig.ownerName, allowGuestDms: discordConfig.allowGuestDms,
  memberIds: discordConfig.memberIds,
});
// Per-member daily turn cap, checked in messageCreate before any paid pre-work.
const turnCap = makeTurnCap({ dbPath: dbFile(dir), surface: "discord" });
const chunkGroups = makeChunkGroups({ dbPath: dbFile(dir) });
// The at-cap line goes out once per member per day per conversation (this process).
const capNotices = new Set<string>();
let capNoticeDay = "";
const transcribe = makeOpenAITranscribe(beanConfig.openaiApiKey);
const speak = makeOpenAISpeak(beanConfig.openaiApiKey);

const bot = buildTeamsBot({
  onActivity: parentActivitySink,
  chat: converseChat,
  model: beanConfig.model,
  loadSkills: () => loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  loadProjects: () => loadProjects(projectsFile(dir)),
  loadPersona: () => loadPersona(personaFile(dir), personaFile(builtinDir)),
  loadMemories: (subject) => loadMemories(dbFile(dir), subject),
  loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
  saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
  detectClis: clis,
  cliModels,
  runs,
  proposals,
  noteProposals,
  saveNote: (draft) => saveNote(dbFile(dir), draft),
  saveNoteImage: (bytes) => saveNoteImage(dbFile(dir), bytes),
  searchNotes: (query) => searchNotes(dbFile(dir), query),
  noteArchiveProposals: new NoteArchiveProposalStore(),
  archiveNote: (slug) => archiveNote(dbFile(dir), slug),
  restoreNote: (slug) => restoreNoteOutcome(dbFile(dir), slug),
  todoProposals: new TodoProposalStore(),
  queueTodo: async (routine, text, createdBy) => {
    const target = resolveTodoRoutine(await loadRoutines(routinesDir(dir)), routine, createdBy !== undefined);
    await addTodo(dbFile(dir), routine, text, undefined, undefined, createdBy);
    return target;
  },
  listTodoRoutines: async (member) => (await loadRoutines(routinesDir(dir)))
    .filter((r) => (member ? memberTodoEligible(r) : r.todoDriven)).map((r) => r.name),
  listOpenTodos: (createdBy) => listOpenTodos(dbFile(dir), createdBy),
  cancelTodo: (id, createdBy) => cancelPendingTodo(dbFile(dir), id, createdBy),
  skillProposals: new SkillProposalStore(),
  saveSkill: (name, body) => saveSkill(skillsDir(dir), name, body),
  appendMemories: (m) => appendMemories(dbFile(dir), m),
  deleteMemories: (ids, subject) => deleteMemories(dbFile(dir), ids, subject),
  shareMemory: (id, actor) => shareMemory(dbFile(dir), id, actor),
  conversations,
  catalog: new ConversationCatalog(dbFile(dir), "discord"),
  liveSessions,
  liveSessionProposals,
  // Always on for Discord (no `liveSessions` opt-in) when a live-capable CLI (claude, codex or opencode)
  // is both detected and not in config's disabledClis list.
  liveSessionsEnabled: () => clis().some(isLiveCli),
  findDelegateRun: (sessionId) => findDelegateRun(dbFile(dir), sessionId),
  scratchPath,
  cards: discordCards,
  reminders: { file: remindersFile(dir), transport: "discord" },
  systemControlsEnabled: () => beanConfig.systemControls,
  webSearchEnabled: () => beanConfig.webSearch,
  // Re-read per DM so a Settings toggle applies without a restart; unreadable config = off.
  autoMemoryEnabled: () => loadConfig(configFile(dir), dir).then((c) => c.autoMemory, () => false),
  imageGen: { generate: makeOpenAIImageGen(beanConfig.openaiApiKey), model: beanConfig.imageModel, imagesDir: imagesDir(dir) },
  roles,
  chatter: makeChatter({ dbPath: dbFile(dir), surface: "discord" }),
  routines: {
    transport: "discord",
    load: () => loadRoutines(routinesDir(dir)),
    save: (r) => saveRoutine(routinesDir(dir), r),
    create: (r) => createRoutine(routinesDir(dir), r),
    // No channel = the owner's DM.
    notifyOwner: async (body) => { await enqueueOutbox(outboxDir(beanDir()), { transport: "discord", body }, () => randomUUID()); },
    // The owner and household members — the only people a routine may DM — by display name.
    recipients: () => Promise.all([discordConfig.ownerId, ...discordConfig.memberIds].map(async (id) => ({
      id, name: await client.users.fetch(id).then((u) => u.displayName, () => id),
    }))),
    proposals: new RoutineProposalStore(),
  },
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
const selections = new Map<string, { cli?: string; model?: string; skillName?: string }>();

// Admin scope is the channel, not the thread: a thread's parent channel (computed before
// startThread reassigns the turn's channel). History, cards and runs keep the thread id.
const scopeOf = (channel: TextBasedChannel): string =>
  channel.isThread() ? channel.parentId ?? channel.id : channel.id;

// The conversation catalog's kind and title for a channel (display only).
const placeOf = (channel: TextBasedChannel): ConversationPlace =>
  channel.isDMBased() ? { kind: "dm", title: "DM" }
  : channel.isThread() ? { kind: "thread", title: channel.name }
  : { kind: "channel", title: "name" in channel && channel.name ? `#${channel.name}` : "channel" };

// bot.ts's keyword commands (same optional leading slash). They act on the channel and answer
// in one line, so they never open a session thread. Chatty/mute/unmute reuse core's parser.
const KEYWORD_RE = /^\/*(?:(?:cancel|new|stop|drivers|whoami|admins|usage|sprouts|routines)$|live-session\b|(?:add|remove)-admin\b|(?:enable|disable)\s)/i;
const isKeywordCommand = (text: string): boolean => KEYWORD_RE.test(text) || parseChatterCommand(text) !== undefined;

// A thread Bean opened is a session: every message in it is addressed to Bean. The Discord
// API's ownerId survives restarts, so no local record of owned threads is needed.
const isBeanThread = (channel: TextBasedChannel): boolean =>
  channel.isThread() && channel.ownerId === client.user?.id;

// Rebuild the live-session proposal card from the current (possibly edited) proposal — used to
// re-render in place after the Edit-prompt modal changes the text.
async function liveSessionCardFor(
  proposalId: string,
  proposal: ProposedLiveSession,
): Promise<object> {
  const [projects, skills] = await Promise.all([
    loadProjects(projectsFile(dir)),
    loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  ]);
  // A resumed session's folder may be unregistered: show its name, never the path (shared channel).
  const projectName = projects.find((p) => p.path === proposal.projectPath)?.name
    ?? (proposal.resume ? basename(proposal.projectPath) || "project" : proposal.projectPath);
  const liveClis = clis().filter(isLiveCli);
  const cli = proposal.resume?.cli ?? proposal.cli ?? liveClis[0] ?? "claude";
  return discordCards.liveSessionProposalCard({
    proposalId, projectName, instruction: proposal.instruction, model: proposal.model, skillName: proposal.skillName,
    steering: proposal.steering,
    projects: projects.map((p) => ({ name: p.name, path: p.path })),
    models: availableModels(cliModels, proposal.resume ? [cli] : liveClis),
    skills: skills.filter((s) => !s.hidden && s.enabled !== false).map((s) => ({ name: s.name })),
    cli,
    ...(proposal.resume ? { clis: [], continues: proposal.resume.instruction, agent: cli } : { clis: liveClis }),
  });
}

// Rebuild the delegate proposal card after an Edit-prompt change. The select defaults come from
// the message's pending `selections` (what Run will send), falling back to the proposal's own.
async function delegateCardFor(pending: PendingProposal, sel: { cli?: string; model?: string; skillName?: string }): Promise<object> {
  const [projects, skills] = await Promise.all([
    loadProjects(projectsFile(dir)),
    loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
  ]);
  const skillName = sel.skillName !== undefined
    ? (sel.skillName === "__none__" ? undefined : sel.skillName)
    : pending.proposal.skillName;
  const detected = clis();
  return discordCards.proposalCard({
    proposalId: pending.id,
    projectName: projects.find((p) => p.path === pending.proposal.projectPath)?.name ?? pending.proposal.projectPath,
    skillName, instruction: pending.proposal.instruction, clis: detected,
    skills: skills.filter((s) => !s.hidden && s.enabled !== false).map((s) => ({ name: s.name, ...(s.browser ? { browser: true } : {}) })),
    models: availableModels(cliModels, detected),
    defaultCli: detected.find((c) => c === sel.cli) ?? pending.defaultCli,
    defaultModel: sel.model ?? pending.defaultModel,
  });
}

// Cards posted while answering a voice message, by message id: a Run click on one arrives as a
// separate interaction, and this is how its delegate result knows to be spoken too. Claimed
// (deleted) on the card's first button click, like `selections`.
const voiceCards = new Set<string>();

// `voiceReply`: the user spoke this turn, so each reply also carries a spoken mp3 — text stays
// for reading where audio can't be played.
function effectsFor(channel: TextBasedChannel, triggeringMessageId?: string, voiceReply = false): BotEffects {
  const send = async (options: string | MessageCreateOptions): Promise<Message> => {
    if (!("send" in channel)) throw new Error("channel is not sendable");
    return channel.send(options as MessageCreateOptions);
  };
  const reply = async (text: string): Promise<void> => {
    await sendChunks(text, send, chunkGroups);
    if (!voiceReply || !text.trim()) return;
    // Audio is a bonus on top of the text already sent — a TTS failure must not fail the turn.
    try {
      await send({ files: [{ attachment: await speak(text), name: "bean-reply.mp3" }] });
    } catch (err) {
      console.error("voice reply failed:", err);
    }
  };
  return {
    reply,
    postResult: reply,
    post: async (text) => { await sendChunks(text, send, chunkGroups); },
    postCard: async (card) => {
      const { id } = await send(card as MessageCreateOptions);
      if (voiceReply) voiceCards.add(id);
      return id;
    },
    // Live-session stream messages: plain sends, so they never land in voiceCards (no click claims them).
    postStream: async (text) => (await send(text)).id,
    updateCard: async (activityId, card) => {
      if (!("messages" in channel)) return;
      const msg = await channel.messages.fetch(activityId);
      await msg.edit(card as Parameters<Message["edit"]>[0]);
    },
    sendFile: async (path, caption) => { await send({ content: caption ?? "", files: [path] }); },
    fetchRecent: async (sinceMs) => {
      // Everything in a Bean thread is already a turn in its history — no ambient chatter.
      if (!("messages" in channel) || isBeanThread(channel)) return [];
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

function toRef(m: Message | MessageSnapshot): RefMessage {
  return {
    authorId: m.author?.id,
    fromName: m.member?.displayName ?? m.author?.displayName ?? "someone",
    content: m.content ?? "",
    embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, fields: e.fields })),
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name })),
    at: m.createdTimestamp,
  };
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    // A live session already running in this channel is itself the authorization boundary
    // for steering it (core's onMessage applies the starter/co-driver check). Outside one,
    // every addressed speaker gets a turn at their role (owner / admin / guest).
    const capturing = liveSessions.has(message.channelId);
    const isDm = message.channel.type === ChannelType.DM;
    const scopeId = scopeOf(message.channel);
    // Role before any paid pre-work: a non-owner DM with guest DMs off gets core's one fixed
    // line (or a whoami answer) — no transcription, no downloads.
    const role: Role = roles.roleOf({ fromId: message.author.id, scopeId: isDm ? undefined : scopeId });
    const dmBlocked = isDm && !dmAllowed(role, roles);
    // Only an explicit address (DM, @mention, reply-to-Bean) gets a turn. Naming the bot in
    // passing ("we should add x to bean") is about Bean, not to it — it stays ambient context.
    const addressed =
      isDm ||
      isBeanThread(message.channel) ||
      message.mentions.users.has(client.user?.id ?? "") ||
      message.mentions.repliedUser?.id === client.user?.id;
    if (!addressed && !capturing) {
      // Chatter in a channel or user-made thread may earn a text-only chime-in (if `chatty on` in
      // its channel). DMs and Bean threads are always addressed, and capturing never gets here.
      const channel = message.channel;
      if (message.content && "send" in channel) {
        bot.onAmbient(channel.id, scopeId, {
          fetchRecent: effectsFor(channel).fetchRecent!,
          // Same channel/thread, never a new thread; nothing in it pings anyone.
          post: async (text) => { await channel.send({ content: text, allowedMentions: { parse: [] } }); },
        }, {
          // Household memory capture (#463): the id gates (role), the name only labels a saved fact.
          fromId: message.author.id, name: message.member?.displayName ?? message.author.displayName,
          text: message.content, at: message.createdTimestamp,
          react: async () => { await message.react("🧠"); },
        });
      }
      return;
    }
    let text = message.content.replace(new RegExp(`<@!?${client.user?.id ?? ""}>`, "g"), "").trim();
    // A forward arrives with empty content; its snapshot is the thing to talk about.
    const forward = message.reference?.type === MessageReferenceType.Forward ? message.messageSnapshots.first() : undefined;
    // Owner-only `usage`: today's turn counts. Anyone else gets one line (a blocked DM falls
    // through to core's DM refusal) — never a free, uncounted model turn.
    if (!capturing && !dmBlocked && /^\/*usage$/i.test(text)) {
      if (role !== "owner") { await message.reply("Only the owner can see usage."); return; }
      const rows = turnCap.usage();
      await message.reply(rows.length === 0
        ? `No member turns yet today (${localTimeZone()}).`
        : `Today's turns (${localTimeZone()}, cap ${DAILY_TURN_CAP}): ${rows.map((r) => `${r.name} ${r.count}`).join(", ")}.`);
      return;
    }
    // Daily turn cap, before transcription, downloads and the thread title. Only turns headed for
    // converse() count: not the owner, blocked DMs, live-session steering, or a keyword command
    // bot.ts answers itself — mirrored from its checks, and only without audio (a transcript
    // appended to `whoami` turns it into a model turn). Counted on admission, so a turn that
    // later fails still counts.
    // Typed `stop` is absent on purpose: with no live session (capturing turns never count) it stays a model turn.
    const cmd = text.toLowerCase().replace(/^\/+/, "");
    const hasAudio = message.attachments.some((a) => a.contentType?.startsWith("audio/") === true && a.size <= 25 * 1024 * 1024);
    const chatterCmd = parseChatterCommand(text);
    const coreCommand = !hasAudio &&
      (cmd === "cancel" || cmd === "new" || cmd === "drivers" || parseRoleCommand(text) !== undefined || parseRoutineCommand(text) !== undefined ||
        // A DM mute/unmute is a model turn in bot.ts (the Mac's volume), so it counts there.
        (chatterCmd !== undefined && (!isDm || chatterCmd.kind === "chatty" || chatterCmd.kind === "memory")) ||
        /^\/?live-session\b/i.test(text));
    const usable = text !== "" || hasAudio || forward !== undefined || message.attachments.some((a) => {
      const mime = a.contentType?.split(";")[0]?.trim() ?? "";
      return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime) && a.size <= 10 * 1024 * 1024;
    });
    if (
      role !== "owner" && !capturing && !dmBlocked && !coreCommand && usable &&
      !turnCap.admit({ turnId: message.id, userId: message.author.id, userName: message.author.displayName })
    ) {
      const day = localDay();
      if (day !== capNoticeDay) { capNotices.clear(); capNoticeDay = day; }
      const key = `${message.author.id}:${message.channelId}`;
      if (!capNotices.has(key)) {
        capNotices.add(key);
        await message.reply(`You've used today's ${DAILY_TURN_CAP} messages — resets at midnight (${localTimeZone()}).`);
      }
      return;
    }
    // Voice messages (and other audio clips ≤25MB, the transcription API cap) arrive with empty
    // content — transcribe them into the turn's text so they get a normal reply. In a captured
    // channel only someone who can steer the session pays for a transcription (onMessage would
    // drop anyone else's turn anyway).
    const canTranscribe = !dmBlocked &&
      (!capturing || (role !== "member" && liveSessions.canSteer(message.channelId, message.author.id)));
    let transcribeFailed = false;
    let heardAudio = false;
    // What the sender typed, before any transcript is appended: an attached clip may be someone
    // else's recording, so only this is a direct-memory source (IncomingMessage.typedText).
    const typed = text;
    for (const att of canTranscribe ? message.attachments.values() : []) {
      if (!att.contentType?.startsWith("audio/") || att.size > 25 * 1024 * 1024) continue;
      try {
        const res = await fetch(att.url);
        if (!res.ok) { console.error(`audio fetch failed: ${res.status}`); transcribeFailed = true; continue; }
        const heard = await transcribe(await res.arrayBuffer(), att.name, att.contentType.split(";")[0]!.trim());
        if (heard) { text = text ? `${text}\n\n${heard}` : heard; heardAudio = true; }
      } catch (err) {
        console.error("audio transcription failed:", err);
        transcribeFailed = true;
      }
    }
    // Image attachments (supported vision formats, ≤10MB) ride along as vision input; an
    // image-only message still gets a turn. Skipped while a live session captures the
    // channel — the bridged agent only takes text, so downloading would silently drop them.
    const images: ImageAttachment[] = [];
    for (const att of capturing || dmBlocked ? [] : message.attachments.values()) {
      if (images.length >= MAX_IMAGES_PER_MESSAGE) break;
      const mime = att.contentType?.split(";")[0]?.trim() ?? "";
      if (!(SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime) || att.size > 10 * 1024 * 1024) continue;
      try {
        const res = await fetch(att.url);
        // A CDN error page base64'd as image bytes would poison the vision call.
        if (!res.ok) { console.error(`attachment fetch failed: ${res.status}`); continue; }
        // The declared att.size is Discord's claim; the downloaded bytes are what we'd keep.
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > 10 * 1024 * 1024) continue;
        images.push({ data: buf.toString("base64"), mimeType: mime });
      } catch (err) {
        console.error("attachment fetch failed:", err);
      }
    }
    // A blocked DM still reaches core (as "(image)") so its one refusal line is sent.
    if (!text && images.length === 0 && !forward && !dmBlocked) {
      if (transcribeFailed) await message.reply("I couldn't transcribe that voice message — try again, or type it out.");
      return;
    }
    // A top-level address in a plain text channel opens a session thread on that message; the
    // turn (and its cards, runs, results) then lives in the thread. Not while a live session
    // captures the channel — that session owns the channel's turns.
    const turnText = text || (forward && images.length === 0 ? "(forwarded message)" : "(image)");
    // The message this one replies to (or forwards) — resolved before the thread opens, since the
    // turn then runs under the thread's fresh, empty history. Context only (see core's repliedTo).
    const ref = message.reference;
    const repliedTo = capturing || dmBlocked ? undefined : await resolveRepliedTo(
      forward ? { channelId: message.channelId, forward: toRef(forward) }
        // A reference with no type is a reply (Discord's default); a forward is handled above.
        : ref && ref.type !== MessageReferenceType.Forward ? { channelId: ref.channelId, messageId: ref.messageId }
        : undefined,
      {
        channelId: message.channelId,
        botId: client.user?.id ?? "",
        fetch: async (id) => toRef(await message.channel.messages.fetch(id)),
        groups: chunkGroups,
      },
    );
    let channel: TextBasedChannel = message.channel;
    // Both permissions are checked up front: creating a thread Bean can't then post in would
    // swallow the answer, while skipping it falls back to answering in the channel.
    if (
      !capturing && message.channel.type === ChannelType.GuildText && client.user &&
      !isKeywordCommand(text.trim()) &&
      message.channel.permissionsFor(client.user)?.has([
        PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads,
      ])
    ) {
      // The title call + startThread take a moment; show Bean working in the meantime.
      await message.channel.sendTyping();
      try {
        channel = await message.startThread({
          // The user's words lead; the quoted message only fills in what "this" refers to.
          name: await threadTitle(
            repliedTo && !repliedTo.unavailable
              ? `${turnText}\n\nQuoted message they're replying to:\n> ${repliedTo.text.slice(0, 500).replace(/\n/g, "\n> ")}`
              : turnText,
            { chat: converseChat, model: beanConfig.model },
          ),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      } catch (err) {
        // Missing Create Public Threads permission, etc. — answer in the channel as before.
        console.error("startThread failed, replying in channel:", err);
      }
    }
    if ("sendTyping" in channel) await channel.sendTyping();
    // Discord's typing indicator lasts ~10s; refresh it while onMessage is still working.
    const typing = "sendTyping" in channel
      ? setInterval(() => channel.sendTyping().catch(() => {}), 8000)
      : undefined;
    try {
      await bot.onMessage(
        {
          conversationId: channel.id, text: turnText, typedText: heardAudio ? typed : undefined, repliedTo,
          images: images.length > 0 ? images : undefined,
          fromId: message.author.id, fromName: message.author.displayName, scopeId, direct: isDm,
          // Everyone @mentioned except Bean — feeds `+driver`/`-driver` and `add-admin`/`remove-admin`.
          mentionedIds: [...message.mentions.users.keys()].filter((id) => id !== client.user?.id),
          mentions: [...message.mentions.users.values()]
            .filter((u) => u.id !== client.user?.id && !u.bot)
            .map((u) => ({ id: u.id, name: u.displayName })),
          channelName: isDm ? "DM" : "name" in message.channel && message.channel.name ? `#${message.channel.name}` : undefined,
        },
        effectsFor(channel, message.id, heardAudio),
      );
    } finally {
      clearInterval(typing);
    }
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

// A pending live proposal, only if it belongs to this channel. Live ids are sequential
// (`live-<n>`), so a forged customId from another channel could otherwise edit it.
function liveProposalIn(id: string, channelId: string | null): PendingLiveSession | undefined {
  const p = liveSessionProposals.get(id);
  return p?.conversationId === channelId ? p : undefined;
}

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    // Same role check as text messages, scoped to the parent channel (DMs never have admins).
    const role: Role = roles.roleOf({
      fromId: interaction.user.id,
      scopeId: interaction.inGuild() && interaction.channel ? scopeOf(interaction.channel) : undefined,
    });
    if (interaction.isChatInputCommand()) {
      // Every pick is core's onCommand, the same handler a typed command reaches. The answer is
      // ephemeral; cards and live-session posts still go to the channel.
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId);
      if (!channel?.isTextBased()) {
        await interaction.editReply("I can't post in this channel.");
        return;
      }
      const inGuild = interaction.inGuild();
      const parent = channel.isThread() ? channel.parent : channel;
      const target = interaction.options.getUser("user");
      const msg = slashMessage({
        commandName: interaction.commandName,
        user: { id: interaction.user.id, name: interaction.user.displayName },
        target: target ? { id: target.id, name: target.displayName, bot: target.bot } : undefined,
        arg: interaction.options.getString("name") ?? interaction.options.getString("prompt") ?? undefined,
        conversationId: interaction.channelId,
        scopeId: inGuild ? scopeOf(channel) : undefined,
        direct: !inGuild,
        channelName: !inGuild ? "DM" : parent && "name" in parent && parent.name ? `#${parent.name}` : undefined,
      });
      const fx = effectsFor(channel);
      await answerSlash((own) => bot.onCommand(msg, { ...fx, ...own }), {
        editReply: (text) => interaction.editReply(text),
        followUp: (text) => interaction.followUp({ content: text, ephemeral: true }),
        announce: async (text) => {
          if (!("send" in channel)) throw new Error("channel is not sendable");
          await channel.send({ content: text, allowedMentions: { parse: [] } });
        },
      });
      return;
    }
    // Every card control (buttons, selects, edit modals) is gated before it touches pending
    // state — core's onCardAction re-checks the ones that reach it. Ephemeral, so the card
    // stays usable for someone who may.
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      const need = cardActionNeeds(/^bean:([a-z-]+):/.exec(interaction.customId)?.[1]);
      if (!atLeast(role, need)) {
        await interaction.reply({ content: cardTapRefusal(need, role, roles), ephemeral: true });
        return;
      }
    }
    // Edit-prompt modal submit: apply the new text, then re-render the card in place.
    if (interaction.isModalSubmit()) {
      const d = /^bean:delegate-editsubmit:(.*)$/.exec(interaction.customId);
      if (d?.[1] && interaction.isFromMessage()) {
        const pending = proposals.get(d[1]);
        if (!pending || pending.conversationId !== interaction.channelId) {
          await interaction.reply({ content: "Already started or expired — edit not applied.", ephemeral: true });
          return;
        }
        const text = interaction.fields.getTextInputValue("prompt").trim();
        if (text && text.length <= MAX_INSTRUCTION_CHARS) proposals.updateInstruction(pending.id, text);
        await interaction.update(await delegateCardFor(pending, selections.get(interaction.message.id) ?? {}));
        return;
      }
      const m = /^bean:live-editsubmit:(.*)$/.exec(interaction.customId);
      if (!m?.[1] || !interaction.isFromMessage()) return;
      const proposalId = m[1];
      const pending = liveProposalIn(proposalId, interaction.channelId);
      if (!pending) { await interaction.deferUpdate(); return; }
      const text = interaction.fields.getTextInputValue("prompt").trim();
      if (text) liveSessionProposals.update(proposalId, { instruction: text });
      await interaction.update(await liveSessionCardFor(proposalId, pending.proposal));
      return;
    }
    // Edit-prompt button: open the modal prefilled with the current prompt. MUST run before any
    // deferUpdate below — showModal has to be the interaction's first response.
    if (interaction.isButton() && interaction.customId.startsWith("bean:delegate-edit:")) {
      const pending = proposals.get(interaction.customId.slice("bean:delegate-edit:".length));
      if (!pending || pending.conversationId !== interaction.channelId) {
        await interaction.reply({ content: "Already started or expired — edit not applied.", ephemeral: true });
        return;
      }
      await interaction.showModal({
        custom_id: `bean:delegate-editsubmit:${pending.id}`,
        title: "Edit the prompt",
        components: [{ type: 1, components: [{
          type: 4, custom_id: "prompt", label: "Instruction (the skill is still applied)",
          style: 2, required: true, max_length: MAX_INSTRUCTION_CHARS, value: pending.proposal.instruction.slice(0, MAX_INSTRUCTION_CHARS),
        }] }],
      });
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("bean:live-edit:")) {
      const proposalId = interaction.customId.slice("bean:live-edit:".length);
      const pending = liveProposalIn(proposalId, interaction.channelId);
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
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const match = /^bean:([a-z-]+):(.*)$/.exec(interaction.customId);
    if (!match?.[1] || match[2] === undefined) return;
    const [, action, payload] = match;
    await interaction.deferUpdate(); // ack within Discord's 3s window before slow work

    if (interaction.isStringSelectMenu()) {
      // Live-session project/model dropdowns write straight to the pending proposal (Start reads
      // it), unlike the delegate card's cli/model which stay in the per-message selections map.
      const liveValue = interaction.values[0];
      if (action.startsWith("live-") && !liveProposalIn(payload, interaction.channelId)) return;
      if (action === "live-project" && liveValue) { liveSessionProposals.update(payload, { projectPath: liveValue }); return; }
      if (action === "live-model" && liveValue) { liveSessionProposals.update(payload, { model: liveValue }); return; }
      if (action === "live-skill" && liveValue) { liveSessionProposals.update(payload, { skillName: liveValue === "__none__" ? undefined : liveValue }); return; }
      if (action === "live-cli") {
        // Switch engine: drop a model the new CLI doesn't offer, then re-render its model list.
        const pending = liveProposalIn(payload, interaction.channelId);
        if (!pending || pending.proposal.resume || !isLiveCli(liveValue)) return;
        const offered = cliModels.find((e) => e.provider === liveValue)?.models ?? [];
        liveSessionProposals.update(payload, {
          cli: liveValue, ...(pending.proposal.model && !offered.includes(pending.proposal.model) ? { model: undefined } : {}),
        });
        await interaction.editReply(await liveSessionCardFor(payload, pending.proposal));
        return;
      }
      const sel = selections.get(interaction.message.id) ?? {};
      if (action === "cli") sel.cli = interaction.values[0];
      if (action === "model") sel.model = interaction.values[0];
      if (action === "skill") sel.skillName = interaction.values[0];
      selections.set(interaction.message.id, sel);
      return;
    }

    // War-room ⇄ restricted toggle on the live-session card: flip the pending proposal and
    // re-render in place. Pre-launch config: owner-only like every live-session control (gated above).
    if (action === "live-mode") {
      const pending = liveProposalIn(payload, interaction.channelId);
      if (pending) {
        const next = pending.proposal.steering === "open" ? "restricted" : "open";
        liveSessionProposals.update(payload, { steering: next });
        await interaction.editReply(await liveSessionCardFor(payload, { ...pending.proposal, steering: next }));
      }
      return;
    }
    if (!interaction.channel) return;
    if (action === "cancel-run") {
      await bot.onCardAction(
        {
          conversationId: interaction.channelId, fromId: interaction.user.id, scopeId: scopeOf(interaction.channel),
          fromName: interaction.user.displayName, value: { beanAction: "cancel-run", runId: payload },
        },
        effectsFor(interaction.channel),
      );
      return;
    }
    const sel = selections.get(interaction.message.id) ?? {};
    selections.delete(interaction.message.id);
    const fx = effectsFor(interaction.channel, undefined, voiceCards.delete(interaction.message.id));
    await bot.onCardAction(
      {
        conversationId: interaction.channelId,
        fromId: interaction.user.id,
        scopeId: scopeOf(interaction.channel),
        fromName: interaction.user.displayName,
        place: placeOf(interaction.channel),
        value: { beanAction: action, proposalId: payload, cli: sel.cli, model: sel.model, skillName: sel.skillName },
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
  // Headless: stop the scheduler, let its queued .state.json writes land, kill routine children.
  if (!stopRoutines) process.exit(0);
  void stopRoutines().finally(() => process.exit(0));
});

client.once("clientReady", async () => {
  console.log(`@bean/discord logged in as ${client.user?.tag} (clis: ${clis().join(", ") || "none"})`);
  // Every core keyword command, from the shared catalog; live-session too (core answers
  // "disabled" when no live-capable CLI is around).
  const commands = slashCommands();
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
// Digest/notice delivery appends straight to the store, bypassing bot.onMessage — which is the
// only other place maybeCompact runs. Without this, a channel that only ever *receives* messages
// (an opted-in routine sink nobody replies in) grows unbounded and the first follow-up ships the
// whole pile. Fire-and-forget, same as bot.ts's call.
const appendDelivered = (conversationId: string, body: string): void => {
  conversations.append(conversationId, { role: "assistant", content: body });
  void maybeCompact(conversationId, conversations, { chat: converseChat, model: beanConfig.model });
};

const OUTBOX_POLL_MS = 5_000;
// One owner notice for a given-up message. A failed owner DM gets none — that's the channel the
// notice would use, and the notice is itself an owner DM, so its own failure can't loop.
const onOutboxGiveUp = async (msg: OutboxMessage, err: unknown): Promise<void> => {
  console.error(`outbox: discord send gave up after ${OUTBOX_MAX_ATTEMPTS} attempts`, err);
  if (!msg.channel && !msg.userId) return;
  const target = msg.channel ? `<#${msg.channel}>` : `<@${msg.userId}>`;
  const reason = err instanceof Error ? err.message : String(err);
  await enqueueOutbox(outboxDir(beanDir()), {
    transport: "discord",
    body: `Couldn't deliver${msg.title ? ` "${msg.title}"` : " a message"} to ${target}: ${reason}`,
  }, () => randomUUID());
};
await recoverOutbox(outboxDir(beanDir()), "discord", onOutboxGiveUp);
setInterval(() => {
  void drainOutbox(outboxDir(beanDir()), "discord", async (msg) => {
    // displayBody present = an interrupted-run notice: msg.body carries the full instruction
    // (needed below so a later "retry" has context), too long to post as-is — show the short
    // version instead. Absent for plain messages (routine digests), which already are the
    // display text.
    const text = msg.displayBody ?? (msg.title ? `**${msg.title}**\n${msg.body}` : msg.body);
    if (!msg.channel) {
      // No channel = DM `msg.userId` (a routine sink's `user`), else the owner (the default).
      const dmChannelId = await deliverOutboxDm(msg, text, {
        ownerId: discordConfig.ownerId,
        fetchUser: (id) => client.users.fetch(id),
        groups: chunkGroups,
      });
      if (msg.context && dmChannelId) appendDelivered(dmChannelId, msg.body);
      return;
    }
    const channel = await client.channels.fetch(msg.channel);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`channel ${msg.channel} not sendable`);
    await sendChunks(text, async (chunk): Promise<{ id: string }> => channel.send(chunk), chunkGroups);
    if (msg.displayBody || msg.context) appendDelivered(msg.channel, msg.body);
  }, onOutboxGiveUp).catch((err: unknown) => console.error("outbox: discord drain failed", err));
}, OUTBOX_POLL_MS);

// Before login: boot cleanup of stale run reservations must finish before a chat run can reserve.
if (headless) {
  stopRoutines = await startHeadlessRoutines({
    dir, builtinDir, converse: converseChat, model: beanConfig.model, clis, cliModels,
    delegateCli: beanConfig.delegateCli, routineDigestContext: beanConfig.routineDigestContext, ownerId: discordConfig.ownerId,
  });
}

// Die with the desktop app that spawned us — see exitWhenOrphaned's doc comment. Discord
// binds no port, so a stale orphan doesn't announce itself with EADDRINUSE: it just stays
// logged in and answers alongside the new one.
exitWhenOrphaned();

await client.login(discordConfig.botToken);
