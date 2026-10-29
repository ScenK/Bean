import {
  beanDir, ensurePrivateBeanDir, scratchDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, dbFile, modelMemoryFile, routinesDir, remindersFile,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, saveNoteImage, searchNotes, archiveNote, restoreNoteOutcome, NoteArchiveProposalStore, appendMemories, deleteMemories, shareMemory,
  detectClis, type CliName, runDelegate, drainOutbox, recoverOutbox, enqueueOutbox, OUTBOX_MAX_ATTEMPTS, type OutboxMessage, outboxDir, saveSkill, addTodo, listOpenTodos, cancelPendingTodo, loadRoutines, saveRoutine, createRoutine, RoutineProposalStore, memberTodoEligible, resolveTodoRoutine,
  buildTeamsBot, exitWhenOrphaned, type BotEffects, AmbientStore, ConversationStore, maybeCompact, NoteProposalStore, ProposalStore,
  RunRegistry, parentActivitySink, SkillProposalStore, TodoProposalStore, loadCliModels, clisFile,
  LiveSessionProposalStore, LiveSessionRegistry, isLiveCli, findDelegateRun, imagesDir, makeOpenAIImageGen, MAX_IMAGES_PER_MESSAGE, SUPPORTED_IMAGE_MIMES, type ImageAttachment, makeRoles, makeChatter, dmAllowed,
} from "@bean/core";
import {
  ActivityTypes, CloudAdapter, ConfigurationBotFrameworkAuthentication, ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference, type Activity,
} from "botbuilder";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  finishedCard, rememberedCard, reminderCard, noteProposalCard, noteResultCard, noteArchiveProposalCard, noteArchiveResultCard, proposalCard, runningCard,
  skillProposalCard, skillResultCard, todoProposalCard, todoResultCard, routineProposalCard, routineResultCard,
  liveSessionProposalCard, liveSessionResultCard,
} from "./cards.js";
import { addressedToBot } from "./addressing.js";
import { startDevtunnel } from "./devtunnel.js";
import { parseQuote } from "./replied-to.js";
import { deliveredAppend, loadTeamsConfig, ownerDmRefs, teamsConfigFile } from "./teams-config.js";
import { teamsText } from "./teams-text.js";

const dir = beanDir();
ensurePrivateBeanDir(dir);
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

// Teams channel conversation ids carry the thread: `19:...@thread.tacv2;messageid=<rootPost>`.
// Sending to the bare id (no `;messageid=`) creates a NEW post in the channel; the full id
// replies in that thread. Channel refs are stored under the bare id so a routine sink can
// name the channel itself and get a fresh post per digest.
const bareChannelId = (id: string): string => id.split(";")[0] ?? id;
// Refs saved before channel keys went bare are keyed `...;messageid=`: re-key them.
for (const [key, ref] of Object.entries(conversationRefs)) {
  if (ref.conversation?.conversationType !== "channel" || !key.includes(";")) continue;
  delete conversationRefs[key];
  const id = bareChannelId(key);
  conversationRefs[id] ??= { ...ref, activityId: undefined, conversation: { ...ref.conversation, id } };
}

async function rememberConversation(ref: Partial<ConversationReference>): Promise<void> {
  const raw = ref.conversation?.id;
  if (!raw || !ref.conversation) return;
  const id = ref.conversation.conversationType === "channel" ? bareChannelId(raw) : raw;
  if (conversationRefs[id]) return;
  // activityId dropped: continueConversationAsync turns it into replyToId, which would pin a
  // proactive post to the mentioning message's thread even when the conversation id is bare.
  conversationRefs[id] = { ...ref, activityId: undefined, conversation: { ...ref.conversation, id } };
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

// Re-scanned per call so a CLI installed after the bot started is picked up.
const clis = (): CliName[] => detectClis().filter((c) => !beanConfig.disabledClis.includes(c));
const cliModels = await loadCliModels(clisFile(builtinDir), clisFile(dir));
const runs = new RunRegistry(runDelegate, { dir, botKind: "teams", onActivity: parentActivitySink });
// Kept as its own reference (not just inline in buildTeamsBot's deps) so the outbox delivery
// loop below can append an interrupted-run notice to the same history bot.onMessage reads —
// otherwise a later "retry" in this conversation has no idea what it's retrying.
// Hoisted out of the bot deps so the outbox loop's maybeCompact can reuse the same client.
const converseChat = makeOpenAIConverse(beanConfig.openaiApiKey, beanConfig.reasoningEffort);
const conversations = new ConversationStore(dbFile(dir));
// Hoisted (not inline in deps) so the /api/messages handler can check `has()` to capture
// steer messages for a bound session, and the SIGTERM handler can kill them. Mirrors Discord.
const liveSessions = new LiveSessionRegistry(undefined, { dir, onActivity: parentActivitySink });
const liveSessionProposals = new LiveSessionProposalStore();
// Hosts delegates not tied to a project (a Jira ticket, research); spawn needs the cwd to exist.
const scratchPath = scratchDir(dir);
mkdirSync(scratchPath, { recursive: true });

const roles = makeRoles({
  dbPath: dbFile(dir), surface: "teams",
  ownerId: teamsConfig.ownerId, ownerName: teamsConfig.ownerName, allowGuestDms: teamsConfig.allowGuestDms,
});
// No owner = setup mode (fail closed): everyone is a guest; `whoami` shows the ids to configure.
if (!teamsConfig.ownerId) console.warn("teams: no ownerId in teams.json — everyone is a guest. Send `whoami` to Bean, then set ownerId.");

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
  proposals: new ProposalStore(),
  noteProposals: new NoteProposalStore(),
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
  liveSessions,
  liveSessionProposals,
  // Same rule as Discord: on whenever a live-capable CLI (claude, codex or opencode) is detected and not
  // disabled. The Teams sink posts/edits via the proactive path (postCard below) so streamed
  // turns land after the triggering turn ends.
  liveSessionsEnabled: () => clis().some(isLiveCli),
  findDelegateRun: (sessionId) => findDelegateRun(dbFile(dir), sessionId),
  scratchPath,
  cards: {
    proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, noteArchiveProposalCard, noteArchiveResultCard, rememberedCard, reminderCard,
    skillProposalCard, skillResultCard, todoProposalCard, todoResultCard, routineProposalCard, routineResultCard,
    liveSessionProposalCard, liveSessionResultCard,
  },
  // Fired by the desktop app's reminder loop into the outbox; the drain below delivers them.
  reminders: { file: remindersFile(dir), transport: "teams" },
  systemControlsEnabled: () => beanConfig.systemControls,
  webSearchEnabled: () => beanConfig.webSearch,
  imageGen: { generate: makeOpenAIImageGen(beanConfig.openaiApiKey), model: beanConfig.imageModel, imagesDir: imagesDir(dir) },
  roles,
  chatter: makeChatter({ dbPath: dbFile(dir), surface: "teams" }),
  // Digests reach a channel/group chat via scopeOf's keys, or the owner's 1:1 (no channel).
  routines: {
    transport: "teams",
    load: () => loadRoutines(routinesDir(dir)),
    save: (r) => saveRoutine(routinesDir(dir), r),
    create: (r) => createRoutine(routinesDir(dir), r),
    // No channel = the owner's DM.
    notifyOwner: async (body) => { await enqueueOutbox(outboxDir(beanDir()), { transport: "teams", body }, () => randomUUID()); },
    // Owner only: a Teams digest DMs nobody else.
    recipients: async () => (teamsConfig.ownerId ? [{ id: teamsConfig.ownerId, name: teamsConfig.ownerName ?? "owner" }] : []),
    proposals: new RoutineProposalStore(),
  },
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Buffer a response body up to MAX_IMAGE_BYTES; null when over the cap.
 * ponytail: Content-Length check + post-buffer check, no streaming enforcement — the only
 * caller fetches from Microsoft's own SMBA endpoint, whose Content-Length is reliable. */
async function readCapped(res: Response): Promise<Buffer | null> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) { await res.body?.cancel(); return null; }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.byteLength > MAX_IMAGE_BYTES ? null : buf;
}

/** Teams inline images arrive as image/* attachments whose contentUrl sits on the SMBA
 * endpoint and requires the bot's own bearer token — a plain fetch gets a 401.
 * Only call for messages that actually get a turn (addressed/captured) — ambient chatter
 * must stay context-only, no downloads. */
async function downloadImages(a: Activity): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const att of a.attachments ?? []) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    const mime = att.contentType?.split(";")[0]?.trim() ?? "";
    if (!(SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime) || !att.contentUrl) continue;
    try {
      const creds = await credentialsFactory.createCredentials(
        teamsConfig.botAppId, "https://api.botframework.com", "https://login.microsoftonline.com", true,
      );
      const token = await (creds as unknown as { getToken: () => Promise<string> }).getToken();
      const res = await fetch(att.contentUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { console.error(`teams attachment download failed: ${res.status}`); continue; }
      const buf = await readCapped(res);
      if (!buf) continue; // over the 10MB cap
      out.push({ data: buf.toString("base64"), mimeType: mime });
    } catch (err) {
      console.error("teams attachment download failed:", err);
    }
  }
  return out;
}

// chatopsServers.stop() (packages/app/src/chatops-servers.ts) sends SIGTERM with no other
// warning — mark any in-flight run interrupted (durable outbox notice to its conversation)
// before this process disappears, instead of just dying mid-run with the requester left hanging.
process.on("SIGTERM", () => {
  runs.interruptAll(); // synchronous — see its doc comment; safe to exit right after
  liveSessions.forceKillAll(); // don't orphan live `claude -p` process groups on shutdown
  process.exit(0);
});

// Ambient (non-mention) channel messages only reach /api/messages if the Teams app manifest
// grants the RSC permission ChannelMessage.Read.Group — see packages/teams/README.md.
const ambient = new AmbientStore(dbFile(dir));

/** Users @mentioned in this activity, minus the bot — feeds core's `+driver`/`-driver` and
 * `add-admin`/`remove-admin`. Only `29:` user ids: tag and channel mentions are not people. */
function mentionedUsers(a: Activity): { id: string; name: string }[] {
  return (a.entities ?? [])
    .filter((e) => e.type === "mention")
    .map((e) => (e as { mentioned?: { id?: string; name?: string } }).mentioned)
    .filter((m): m is { id: string; name?: string } => !!m?.id && m.id.startsWith("29:") && m.id !== a.recipient.id)
    .map((m) => ({ id: m.id, name: m.name ?? "someone" }));
}

/** Admin scope: the bare channel id for channel posts (not the thread), the group chat's id for
 * group chats. Personal chats have none. */
function scopeOf(a: Activity): string | undefined {
  const c = a.conversation;
  if (c.conversationType === "personal") return undefined;
  return c.conversationType === "channel" ? bareChannelId(c.id) : c.id;
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
    reply: async (text) => { await context.sendActivity({ type: ActivityTypes.Message, text: teamsText(text) }); },
    post: async (text) => { await proactive(async (ctx) => { await ctx.sendActivity({ type: ActivityTypes.Message, text: teamsText(text) }); }); },
    postCard: async (card) => {
      const res = await context.sendActivity({
        type: ActivityTypes.Message,
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
      });
      return res?.id ?? "";
    },
    // Live-session streaming rides these (not postCard, which is adaptive-card-only on Teams):
    // real text messages, posted proactively because turns stream in after the triggering
    // turn's context is dead. postStream returns the activity id so editStream can revise it.
    postStream: async (text) => {
      let id = "";
      await proactive(async (ctx) => {
        const res = await ctx.sendActivity({ type: ActivityTypes.Message, text: teamsText(text) });
        id = res?.id ?? "";
      });
      return id;
    },
    editStream: async (id, text) => {
      await proactive(async (ctx) => {
        await ctx.updateActivity({
          id, type: ActivityTypes.Message, text: teamsText(text), conversation: ref.conversation,
        } as Partial<Activity> as Activity);
      });
    },
    // Live-session turn indicator: fire-and-forget proactive Typing (turns stream in after the
    // triggering turn's context is dead, same reason as postStream). The registry re-pings it.
    // No sendFile on purpose: Teams rejects large inline base64 activities, and hosting the
    // file (public route + auth tokens + rate limiting) isn't worth it — core's fallback
    // posts the saved file's path instead, and the user opens it locally.
    sendTyping: () => {
      proactive(async (ctx) => { await ctx.sendActivity({ type: ActivityTypes.Typing }); }).catch(() => {});
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
        {
          conversationId: a.conversation.id,
          fromId: a.from.id, // session owner for live-session steering (restricted by default)
          fromAltId: a.from.aadObjectId,
          scopeId: scopeOf(a),
          fromName: a.from.name ?? "someone",
          value: {
            beanAction: value.beanAction, proposalId: value.proposalId, projectPath: value.projectPath, runId: value.runId,
            cli: value.cli, model: value.model,
            skillName: value.skillName, steering: value.steering, instruction: value.instruction,
          },
        },
        fx,
      );
      return;
    }
    // TEMP: confirm the real slash-picker payload on the dev tenant (is `/` in the text, is
    // there a mention entity). stdout only; remove after the check (#359).
    if ((a.recipient as { isTargeted?: unknown }).isTargeted !== undefined) {
      console.log("teams targeted message:", JSON.stringify({
        recipient: a.recipient,
        entities: (a.entities ?? []).map((e) => ({ type: e.type, mentionedId: (e as { mentioned?: { id?: string } }).mentioned?.id })),
        text: a.text?.slice(0, 40),
      }));
    }
    // A quote-reply's quoted message is context, never input: split it out of the typed words.
    const { text, repliedTo } = parseQuote(a, TurnContext.removeRecipientMention(a)?.trim() ?? a.text?.trim() ?? "");
    // A live session bound to this conversation is its own authorization boundary: forward every
    // message (mention or not) so allowed drivers can steer/stop it — core's onMessage decides
    // who may. Mirrors the Discord surface's `capturing` bypass.
    const capturing = liveSessions.has(a.conversation.id);
    if (!addressedToBot(a, `28:${teamsConfig.botAppId}`) && !capturing) {
      // Not for Bean — remember it as context for a later mention, but don't reply.
      if (!text) return;
      ambient.append(a.conversation.id, { fromName: a.from.name ?? "someone", text, at: Date.now() });
      // Channel/group chatter may earn a text-only chime-in (if `chatty on` in its scope); personal
      // chats have no scope and never chime in. The turn context is revoked by the time the lull
      // timer fires, so the post is proactive: the full conversation id keeps it in this thread,
      // and activityId is dropped (it would become replyToId).
      const scopeId = scopeOf(a);
      if (scopeId) {
        const conv = a.conversation.id;
        const ref: Partial<ConversationReference> = { ...TurnContext.getConversationReference(a), activityId: undefined };
        bot.onAmbient(conv, scopeId, {
          fetchRecent: async (sinceMs) => ambient.since(conv, sinceMs),
          post: async (reply) => {
            await adapter.continueConversationAsync(teamsConfig.botAppId, ref, async (ctx) => {
              await ctx.sendActivity({ type: ActivityTypes.Message, text: teamsText(reply) });
            });
          },
        });
      }
      return;
    }
    const direct = a.conversation.conversationType === "personal";
    // Role before any paid pre-work: a non-owner DM with guest DMs off gets core's one fixed
    // line (or a whoami answer), so its images are never downloaded.
    const dmBlocked = direct && !dmAllowed(roles.roleOf({ fromId: a.from.id, fromAltId: a.from.aadObjectId }), roles);
    // Downloaded only after the addressing gate: ambient channel images must not cost
    // token-authenticated fetches for messages Bean immediately discards. Also skipped
    // while a live session captures the conversation — the bridged agent only takes text.
    const images = capturing || dmBlocked ? [] : await downloadImages(a);
    // An image-only message still gets a turn; pure empty messages stay ignored.
    // A blocked DM still reaches core (as "(image)") so its one refusal line is sent.
    if (!text && images.length === 0 && !dmBlocked) return;
    const mentions = mentionedUsers(a);
    fx.fetchRecent = async (sinceMs) => ambient.since(a.conversation.id, sinceMs);
    await context.sendActivity({ type: ActivityTypes.Typing });
    // Teams clears the typing indicator quickly; resend while onMessage is still working.
    // Caught: a send still in flight when the turn ends rejects on the revoked context
    // ("Cannot perform 'set' on a proxy that has been revoked") and would crash the bot.
    const typing = setInterval(() => { context.sendActivity({ type: ActivityTypes.Typing }).catch(() => {}); }, 5000);
    try {
      await bot.onMessage(
        {
          conversationId: a.conversation.id, text: text || "(image)", repliedTo,
          images: images.length > 0 ? images : undefined,
          fromId: a.from.id, fromAltId: a.from.aadObjectId, fromName: a.from.name ?? "someone",
          scopeId: scopeOf(a), direct,
          mentions, mentionedIds: mentions.map((m) => m.id),
          channelName: a.conversation.conversationType === "personal" ? "DM" : a.conversation.name,
        },
        fx,
      );
    } finally {
      clearInterval(typing);
    }
  });
});

// Die with the desktop app that spawned us — see exitWhenOrphaned's doc comment.
exitWhenOrphaned();

// Opt-in public reachability: a startup failure (bad creds, no CLI) throws here, so Settings
// shows it instead of a "running" bot nobody can reach.
if (teamsConfig.devtunnel) {
  await startDevtunnel(teamsConfig.devtunnel, teamsConfig.port, {
    tenantId: teamsConfig.tenantId, clientId: teamsConfig.botAppId, secret: teamsConfig.botAppPassword,
  });
}

let bindFailed = false;
const server = app.listen(teamsConfig.port, () => {
  // Deferred, and guarded: node runs this callback even when the bind is about to fail with
  // EADDRINUSE (it emits "listening" first, then "error"), so logging synchronously here
  // claims we're serving when we're seconds from exiting. The error lands before this
  // setImmediate, so bindFailed is already true by then.
  setImmediate(() => {
    if (bindFailed) return;
    console.log(`@bean/teams listening on :${teamsConfig.port} (clis: ${clis().join(", ") || "none"})`);
  });
});
// Without this the bind failure is invisible: the tray still shows Teams "running" while an
// older server owns the port and answers every message with whatever code it booted with.
server.on("error", (err: NodeJS.ErrnoException) => {
  bindFailed = true;
  console.error(
    err.code === "EADDRINUSE"
      ? `port ${teamsConfig.port} is already in use — another Bean Teams server is still running.`
      : `server error: ${err.message}`,
  );
  process.exit(1);
});

// Routine digests: the main app enqueues outbox files; deliver them via a proactive message.
// Digest/notice delivery appends straight to the store, bypassing bot.onMessage — which is the
// only other place maybeCompact runs. Without this, a channel that only ever *receives* messages
// (an opted-in routine sink nobody replies in) grows unbounded and the first follow-up ships the
// whole pile. Fire-and-forget, same as bot.ts's call.
const appendDelivered = (conversationId: string, body: string): void => {
  conversations.append(conversationId, { role: "assistant", content: body });
  void maybeCompact(conversationId, conversations, { chat: converseChat, model: beanConfig.model });
};

const OUTBOX_POLL_MS = 5_000;
// One owner-DM notice for a given-up channel message. A failed owner DM gets none — the notice
// would ride that same path, and being an owner DM itself, its own failure can't loop.
const onOutboxGiveUp = async (msg: OutboxMessage, err: unknown): Promise<void> => {
  console.error(`outbox: teams send gave up after ${OUTBOX_MAX_ATTEMPTS} attempts`, err);
  if (!msg.channel) return;
  const reason = err instanceof Error ? err.message : String(err);
  await enqueueOutbox(outboxDir(beanDir()), {
    transport: "teams",
    body: `Couldn't deliver${msg.title ? ` "${msg.title}"` : " a message"} to conversation ${msg.channel}: ${reason}`,
  }, () => randomUUID());
};
await recoverOutbox(outboxDir(beanDir()), "teams", onOutboxGiveUp);
setInterval(() => {
  void drainOutbox(outboxDir(beanDir()), "teams", async (msg) => {
    // displayBody present = an interrupted-run notice: msg.body carries the full instruction
    // (needed below so a later "retry" has context), too long to post as-is — show the short
    // version instead. Absent for plain messages (routine digests), which already are the
    // display text.
    const text = msg.displayBody ?? (msg.title ? `**${msg.title}**\n\n${msg.body}` : msg.body);
    // No channel = DM the owner directly: their personal (1:1) conversation(s) only, never
    // another user's who once DMed the bot (the default delivery mode). A specific channel
    // targets one known conversation.
    // A channel target resolves via its bare id but is sent to exactly the id given: bare =
    // new post in the channel, `;messageid=` = reply in that thread (e.g. an interrupted run).
    const known = msg.channel ? conversationRefs[msg.channel] ?? conversationRefs[bareChannelId(msg.channel)] : undefined;
    const targets = msg.channel
      ? (known?.conversation ? [{ ...known, conversation: { ...known.conversation, id: msg.channel } }] : [])
      : ownerDmRefs(conversationRefs, teamsConfig.ownerId);
    // Thrown = retried later: the conversation may become known once someone messages the bot.
    if (targets.length === 0) {
      throw new Error(msg.channel
        ? `unknown teams conversation ${msg.channel} (mention the bot there once first)`
        : teamsConfig.ownerId
          ? "no known personal Teams conversation with the owner yet (DM the bot once first)"
          : "no ownerId in teams.json (set it to your Teams user id or AAD object id)");
    }
    let lastErr: unknown;
    let delivered = false;
    for (const ref of targets) {
      try {
        const posted: { id?: string } = {};
        await adapter.continueConversationAsync(teamsConfig.botAppId, ref, async (context) => {
          posted.id = (await context.sendActivity(teamsText(text)))?.id;
        });
        delivered = true;
        // Per-target, because a DM fanout has no msg.channel to append to.
        const save = ref.conversation?.id ? deliveredAppend(msg, ref.conversation, text, posted.id) : null;
        if (save === "missing-id") console.error(`outbox: teams post to ${ref.conversation?.id} returned no id; digest not saved`);
        else if (save) appendDelivered(save.key, save.body);
      } catch (err) {
        console.error("outbox: teams send failed", err);
        lastErr = err;
      }
    }
    if (!delivered) throw lastErr;
  }, onOutboxGiveUp).catch((err: unknown) => console.error("outbox: teams drain failed", err));
}, OUTBOX_POLL_MS);
