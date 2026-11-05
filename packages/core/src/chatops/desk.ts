import { isValidSessionId } from "../delegate-runs.js";

// Desk ingress: the desktop app sends a turn into a chatops conversation over the bot's Node IPC
// channel (see .memory/project-teams-bot.md → "Desk ingress"). Separate from
// parseChatopsActivity: these carry a request/ack pair and a history-changed ping.
// Privacy: text only ever goes app → bot. Nothing bot → app carries message text — an ack is a
// request id plus ok or a fixed refusal code, `saved` is a conversation id, and a sprout trigger
// (sprout-bridge.ts) is a sprout name, run/check and the asking conversation's id.

/** Why a bot refused a desk turn. A fixed set: the app maps each to its own UI line. */
export const DESK_REFUSALS = [
  "too-long", "not-eligible", "queue-full", "channel-busy", "cli-missing", "no-record", "post-failed", "bot-busy",
] as const;
export type DeskRefusal = (typeof DESK_REFUSALS)[number];
/** Desk-continue's own refusals: no owner configured, the thread couldn't be opened, agent mode
 * (until #696). */
export const DESK_CONTINUE_REFUSALS = ["no-owner", "thread-failed", "unsupported"] as const;
export type DeskContinueRefusal = (typeof DESK_CONTINUE_REFUSALS)[number];

export type DeskTurn = { type: "desk-turn"; requestId: string; conversationId: string; text: string };
/** App → bot: reopen the conversation's ended live session (Continue live). Only the
 * conversation id crosses — CLI, session id and project come from the bot's own records. */
export type DeskResume = { type: "desk-resume"; requestId: string; conversationId: string };
/** App → bot (#695): open a thread in a Discord channel and carry a desktop chat into it. Plain
 * chat carries `tail` (the recent turns, quoted as context; `count` = how many) and agent mode
 * carries the CLI session to move over. The owner is never named — it is the bot's config owner. */
export type DeskContinueBody =
  | { mode: "chat"; channelId: string; title: string; tail: string; count: number }
  | { mode: "agent"; channelId: string; title: string; sessionId: string };
export type DeskContinue = { type: "desk-continue"; requestId: string } & DeskContinueBody;
export type DeskAckResult = { ok: true } | { refused: DeskRefusal };
/** A desk-continue's answer: the thread it opened, or `partial` = the thread exists but a later step
 * (catalog, seed or first post) failed. */
export type DeskContinueResult =
  | { ok: true; threadId: string } | { partial: true; threadId: string } | { refused: DeskRefusal | DeskContinueRefusal };
export type DeskAck = { type: "desk-ack"; requestId: string } & (DeskAckResult | DeskContinueResult);
export type DeskSaved = { type: "saved"; conversationId: string };

/** Longest desk turn a bot runs; longer is refused `too-long` (same cap as a chat instruction). */
export const MAX_DESK_TEXT = 4000;
// Transport ceilings: past these a message is malformed, dropped without an ack.
const MAX_ID = 200;
const MAX_WIRE_TEXT = 64_000;
/** A continued thread's name (Discord's thread-name limit). */
export const MAX_CONTINUE_TITLE = 100;
/** The carried tail: the desktop's 8000-character handoff plus its quote/separator lines. */
export const MAX_CONTINUE_TAIL = 10_000;
const MAX_CONTINUE_COUNT = 200;

const fields = (v: unknown, type: string): Record<string, unknown> | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return o.type === type ? o : undefined;
};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** App → bot, validated in the bot. */
export function parseDeskTurn(v: unknown): DeskTurn | undefined {
  const o = fields(v, "desk-turn");
  if (!o || !id(o.requestId) || !id(o.conversationId)) return undefined;
  if (typeof o.text !== "string" || !o.text.trim() || o.text.length > MAX_WIRE_TEXT) return undefined;
  return { type: "desk-turn", requestId: o.requestId, conversationId: o.conversationId, text: o.text };
}

/** App → bot, validated in the bot. */
export function parseDeskResume(v: unknown): DeskResume | undefined {
  const o = fields(v, "desk-resume");
  return o && id(o.requestId) && id(o.conversationId)
    ? { type: "desk-resume", requestId: o.requestId, conversationId: o.conversationId } : undefined;
}

/** App → bot, validated in the bot. Over-cap or mixed (one mode's fields on the other) payloads
 * are dropped, never trimmed. */
export function parseDeskContinue(v: unknown): DeskContinue | undefined {
  const o = fields(v, "desk-continue");
  if (!o || !id(o.requestId) || !id(o.channelId)) return undefined;
  if (typeof o.title !== "string" || !o.title.trim() || o.title.length > MAX_CONTINUE_TITLE) return undefined;
  const base = { type: "desk-continue" as const, requestId: o.requestId, channelId: o.channelId, title: o.title.trim() };
  if (o.mode === "chat" && o.sessionId === undefined) {
    if (typeof o.tail !== "string" || !o.tail.trim() || o.tail.length > MAX_CONTINUE_TAIL) return undefined;
    if (!Number.isInteger(o.count) || (o.count as number) < 1 || (o.count as number) > MAX_CONTINUE_COUNT) return undefined;
    return { ...base, mode: "chat", tail: o.tail, count: o.count as number };
  }
  if (o.mode === "agent" && o.tail === undefined && o.count === undefined && typeof o.sessionId === "string" && isValidSessionId(o.sessionId)) {
    return { ...base, mode: "agent", sessionId: o.sessionId };
  }
  return undefined;
}

/** Bot → app, validated in the app. Rebuilt from known fields, so nothing extra crosses. */
export function parseDeskAck(v: unknown): DeskAck | undefined {
  const o = fields(v, "desk-ack");
  if (!o || !id(o.requestId)) return undefined;
  const requestId = o.requestId;
  if (o.ok === true && o.refused === undefined && o.partial === undefined) {
    if (o.threadId === undefined) return { type: "desk-ack", requestId, ok: true };
    return id(o.threadId) ? { type: "desk-ack", requestId, ok: true, threadId: o.threadId } : undefined;
  }
  if (o.partial === true && o.ok === undefined && o.refused === undefined && id(o.threadId)) {
    return { type: "desk-ack", requestId, partial: true, threadId: o.threadId };
  }
  if (o.ok === undefined && o.partial === undefined && ([...DESK_REFUSALS, ...DESK_CONTINUE_REFUSALS] as readonly unknown[]).includes(o.refused)) {
    return { type: "desk-ack", requestId, refused: o.refused as DeskRefusal | DeskContinueRefusal };
  }
  return undefined;
}

/** Bot → app, validated in the app. */
export function parseDeskSaved(v: unknown): DeskSaved | undefined {
  const o = fields(v, "saved");
  return o && id(o.conversationId) ? { type: "saved", conversationId: o.conversationId } : undefined;
}

// Same guard as parentActivitySink: no parent = standalone bot, a no-op; the callback form keeps
// a closed channel from surfacing as a process 'error' event that would kill the bot.
const toParent = (m: DeskAck | DeskSaved): void => {
  if (process.send && process.connected) process.send(m, undefined, {}, () => {});
};

/** Answers a desk turn to the parent app. */
export const parentDeskAck = (requestId: string, r: DeskAckResult | DeskContinueResult): void => toParent({ type: "desk-ack", requestId, ...r });

/** `ConversationStore`'s `onChange` for a bot server: tells the app this history changed. */
export const parentSavedSink = (conversationId: string): void => toParent({ type: "saved", conversationId });
