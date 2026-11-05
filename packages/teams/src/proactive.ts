import type { BotEffects, CardAction, ConversationPlace } from "@bean/core";
import { ActivityTypes, type Activity, type ConversationReference, type TurnContext } from "botbuilder";
import { teamsText } from "./teams-text.js";

/** `adapter.continueConversationAsync` bound to the bot's app id — the only way to post outside
 * a live turn context. */
export type ContinueConversation = (ref: Partial<ConversationReference>, fn: (ctx: TurnContext) => Promise<void>) => Promise<void>;

// Teams channel conversation ids carry the thread: `19:...@thread.tacv2;messageid=<rootPost>`.
// Sending to the bare id (no `;messageid=`) creates a NEW post in the channel; the full id
// replies in that thread. Channel refs are stored under the bare id so a routine sink can
// name the channel itself and get a fresh post per digest.
export const bareChannelId = (id: string): string => id.split(";")[0] ?? id;

/** The stored ref for a conversation id, retargeted to exactly that id: a channel resolves via
 * its bare id but sends to the id given (bare = new post, `;messageid=` = reply in that post).
 * Undefined = Bean has never seen the conversation. */
export function refFor(
  refs: Record<string, Partial<ConversationReference>>, id: string,
): Partial<ConversationReference> | undefined {
  const known = refs[id] ?? refs[bareChannelId(id)];
  return known?.conversation ? { ...known, conversation: { ...known.conversation, id } } : undefined;
}

/** A real 1:1 DM with Bean. A `/` pick in a group chat, meeting chat or channel also arrives as
 * `personal` (its own `a:` id), but targeted (`bot.isTargeted`, the activity's `recipient`) —
 * it's a shared conversation: no private recall/capture, no guest-DM gate, no "DM" row (#551).
 * Microsoft only targets messages in shared conversations, so a real DM is never targeted. */
export function isDirect(ref: Partial<ConversationReference>): boolean {
  return ref.conversation?.conversationType === "personal" && (ref.bot as { isTargeted?: unknown } | undefined)?.isTargeted !== true;
}

/** The conversation catalog's kind and title (display only). A channel conversation id carrying
 * `;messageid=` is one post's reply chain. */
export function placeOf(ref: Partial<ConversationReference>): ConversationPlace {
  const c = ref.conversation;
  if (isDirect(ref)) return { kind: "dm", title: "DM" };
  if (c?.conversationType === "channel" && c.id.includes(";")) return { kind: "post", title: c.name || "Teams post" };
  return { kind: "channel", title: c?.name || "Teams chat" };
}

/** `placeOf` for a captured fact's source title: an unnamed group chat gets a short id instead of
 * the generic "Teams chat"/"Teams post" alone, so two unnamed chats stay tellable apart. */
export function capturePlace(ref: Partial<ConversationReference>): ConversationPlace {
  const place = placeOf(ref);
  const id = ref.conversation?.id.replace(/^\d+:/, "").slice(0, 8);
  return ref.conversation?.name || !id ? place : { ...place, title: `${place.title} ${id}` };
}

/** Admin scope for a ref'd conversation: bare channel id for a channel, the chat's id for a group
 * chat, none for a personal chat (same rule as the server's `scopeOf(activity)`). A targeted
 * `personal` conversation is shared but unscoped: its `a:` id isn't the shared chat's, and the
 * payload shows no parent id (yet), so no admins or `chatty` settings apply there. */
export function refScope(ref: Partial<ConversationReference>): string | undefined {
  const c = ref.conversation;
  if (!c || c.conversationType === "personal") return undefined;
  return c.conversationType === "channel" ? bareChannelId(c.id) : c.id;
}

/** A card submit's CardAction. Teams merges every `Input.*` into the submit, so only these value
 * fields are copied (an unlisted field never reaches core); `direct` is the real-DM flag (#689). */
export function cardActionOf(a: Activity, value: Record<string, string | undefined>): CardAction {
  const ref = { conversation: a.conversation, bot: a.recipient };
  return {
    conversationId: a.conversation.id,
    fromId: a.from.id, // session owner for live-session steering (restricted by default)
    fromAltId: a.from.aadObjectId,
    scopeId: refScope(ref),
    fromName: a.from.name ?? "someone",
    place: placeOf(ref),
    direct: isDirect(ref),
    value: {
      beanAction: value.beanAction, proposalId: value.proposalId, projectPath: value.projectPath, runId: value.runId,
      cli: value.cli, model: value.model,
      skillName: value.skillName, steering: value.steering, instruction: value.instruction, destination: value.destination,
    },
  };
}

/** Every effect posted proactively on `ref` — for work with no turn context (a desk turn) and for
 * whatever streams in after the triggering turn's context is dead. */
export function proactiveEffects(ref: Partial<ConversationReference>, proactive: ContinueConversation): BotEffects {
  const send = async (activity: Partial<Activity>): Promise<string> => {
    let id = "";
    await proactive(ref, async (ctx) => { id = (await ctx.sendActivity(activity))?.id ?? ""; });
    return id;
  };
  const update = async (activity: Partial<Activity>): Promise<void> => {
    await proactive(ref, async (ctx) => {
      await ctx.updateActivity({ ...activity, type: ActivityTypes.Message, conversation: ref.conversation } as Activity);
    });
  };
  const card = (content: object): Partial<Activity> => ({
    type: ActivityTypes.Message,
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }],
  });
  const text = (t: string): Partial<Activity> => ({ type: ActivityTypes.Message, text: teamsText(t) });
  return {
    reply: async (t) => { await send(text(t)); },
    post: async (t) => { await send(text(t)); },
    postCard: (c) => send(card(c)),
    updateCard: (id, c) => update({ id, ...card(c) }),
    // Live-session streaming rides these (not postCard, which is adaptive-card-only on Teams):
    // real text messages. postStream returns the activity id so editStream can revise it.
    postStream: (t) => send(text(t)),
    editStream: (id, t) => update({ id, ...text(t) }),
    // Live-session turn indicator: fire-and-forget. The registry re-pings it.
    // No sendFile on purpose: Teams rejects large inline base64 activities, and hosting the
    // file (public route + auth tokens + rate limiting) isn't worth it — core's fallback
    // posts the saved file's path instead, and the user opens it locally.
    sendTyping: () => { proactive(ref, async (ctx) => { await ctx.sendActivity({ type: ActivityTypes.Typing }); }).catch(() => {}); },
  };
}
