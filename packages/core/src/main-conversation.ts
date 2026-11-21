import { openDb } from "./db.js";

// One conversation across the desktop and the owner's DMs (#995): its model history is one
// chatops_turns log under a fixed id, shared by every surface. Dark until the cutover marker is
// written (#999, in the same transaction as the fold of the old histories): before it, Home keeps
// its renderer-built history and nothing reads or writes this log.

/** The main conversation's id in chatops_turns. Never a chatops transport id (those are prefixed). */
export const MAIN_CONVERSATION_ID = "main";

/** The cutover marker's key in memory_meta (plain KV): present = every surface uses the log. */
export const MAIN_CUTOVER_KEY = "mainConversationCutoverAt";

export function mainCutover(file: string): boolean {
  return openDb(file).prepare("SELECT 1 FROM memory_meta WHERE key = ?").get(MAIN_CUTOVER_KEY) !== undefined;
}

/** How long a quiet spell must be for a desktop message to carry the gap marker (#977) — the
 * renderer's GAP_MS, judged host-side from the log for the main conversation. */
export const CHAT_GAP_MS = 3 * 60 * 60 * 1000;

/** A desktop turn for the main log: `key` is the renderer's stable item id (plus a card's state), so
 * a re-sent delta appends once. Posts and pulled DM rows never ride as one. */
export interface KeyedTurn { key: string; role: "user" | "assistant"; content: string }

// A card key carries its record line (catalog names only), so this is roomy.
const MAX_KEY = 1000;

/** A shell's delta, checked: an array (else throws) of keyed user/assistant turns. A malformed entry
 * or an over-long key is dropped, not fatal — one bad card line must not stop Home from saving. */
export function checkKeyedTurns(v: unknown): KeyedTurn[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("malformed chat turns");
  return v.flatMap((t): KeyedTurn[] => {
    const o = t as Partial<KeyedTurn> | null;
    return o && typeof o.key === "string" && o.key && o.key.length <= MAX_KEY && typeof o.content === "string"
      && (o.role === "user" || o.role === "assistant") ? [{ key: o.key, role: o.role, content: o.content }] : [];
  });
}

/** A desktop turn's idempotency key in the log. */
export const desktopTurnKey = (key: string): string => `desktop:${key}`;
/** A delivered outbox message's idempotency key in the log (#998). */
export const deliveryTurnKey = (deliveryId: string): string => `delivery:${deliveryId}`;
/** A drained Home post's idempotency key in the log. */
export const postTurnKey = (postId: string): string => `post:${postId}`;
