// Desk ingress: the desktop app sends a turn into a chatops conversation over the bot's Node IPC
// channel (see .memory/project-teams-bot.md → "Desk ingress"). Separate from
// parseChatopsActivity: these carry a request/ack pair and a history-changed ping.
// Privacy: text only ever goes app → bot. Nothing bot → app carries message text — an ack is a
// request id plus ok or a fixed refusal code, and `saved` is a conversation id.

/** Why a bot refused a desk turn. A fixed set: the app maps each to its own UI line. */
export const DESK_REFUSALS = [
  "too-long", "not-eligible", "queue-full", "channel-busy", "cli-missing", "no-record", "post-failed", "bot-busy",
] as const;
export type DeskRefusal = (typeof DESK_REFUSALS)[number];

export type DeskTurn = { type: "desk-turn"; requestId: string; conversationId: string; text: string };
/** App → bot: reopen the conversation's ended live session (Continue live). Only the
 * conversation id crosses — CLI, session id and project come from the bot's own records. */
export type DeskResume = { type: "desk-resume"; requestId: string; conversationId: string };
export type DeskAckResult = { ok: true } | { refused: DeskRefusal };
export type DeskAck = { type: "desk-ack"; requestId: string } & DeskAckResult;
export type DeskSaved = { type: "saved"; conversationId: string };

/** Longest desk turn a bot runs; longer is refused `too-long` (same cap as a chat instruction). */
export const MAX_DESK_TEXT = 4000;
// Transport ceilings: past these a message is malformed, dropped without an ack.
const MAX_ID = 200;
const MAX_WIRE_TEXT = 64_000;

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

/** Bot → app, validated in the app. Rebuilt from known fields, so nothing extra crosses. */
export function parseDeskAck(v: unknown): DeskAck | undefined {
  const o = fields(v, "desk-ack");
  if (!o || !id(o.requestId)) return undefined;
  if (o.ok === true && o.refused === undefined) return { type: "desk-ack", requestId: o.requestId, ok: true };
  if (o.ok === undefined && (DESK_REFUSALS as readonly unknown[]).includes(o.refused)) {
    return { type: "desk-ack", requestId: o.requestId, refused: o.refused as DeskRefusal };
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
export const parentDeskAck = (requestId: string, r: DeskAckResult): void => toParent({ type: "desk-ack", requestId, ...r });

/** `ConversationStore`'s `onChange` for a bot server: tells the app this history changed. */
export const parentSavedSink = (conversationId: string): void => toParent({ type: "saved", conversationId });
