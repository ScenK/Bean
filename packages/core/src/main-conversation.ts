import { openDb } from "./db.js";
import type { ChatTurn } from "./converse.js";
import { mapSyncedTurn, type SyncedChatRow } from "./chatops/transcript.js";
import { formatSummaryBlock } from "./chatops/compact.js";

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

/** One owner-DM log entry as a desktop display row (#1000): `seq` is its log identity (the shell
 * dedupes by it), `via` the surface that wrote it. */
export interface MainDmRow { seq: number; via: "discord" | "teams"; row: SyncedChatRow }

/** What a shell pulls for the main conversation past its cursor. `cursor` = the log's newest seq
 * (store it, pass it back). `trimmed` = compaction took entries past the old cursor, or more than
 * the pull's cap arrived — the shell shows its trim notice. `cutoverAt` = when the merge went live,
 * set on the first pull with a DM or a summary past the cursor (no DM at or before it). */
export interface MainSince { rows: MainDmRow[]; cursor: number; trimmed: boolean; cutoverAt?: string }

// One pull's display cap; compaction already bounds the log itself.
const MAX_PULL = 200;
const SUMMARY_PREFIX = formatSummaryBlock("");

/** The owner's DM exchanges in the main log after `cursor`: only `discord`/`teams` entries — never a
 * desktop turn (the shell has those), a post, or a summary (no surface). Seqs only grow (MAX + 1;
 * compaction reuses the lowest freed one for its summary), so a seq missing past the cursor means
 * compaction took it. Counts in SQL, only the capped rows' bodies read; one read transaction, so the
 * counts and the rows agree. */
export function mainSince(file: string, cursor: number): MainSince {
  const db = openDb(file);
  const from = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
  const DM = "surface IN ('discord', 'teams')";
  db.exec("BEGIN");
  try {
    const stats = db.prepare(
      `SELECT MAX(seq) AS newest, COUNT(*) AS n, COALESCE(SUM(${DM}), 0) AS dms, ` +
        "COALESCE(SUM(surface IS NULL AND substr(content, 1, ?) = ?), 0) AS summaries " +
        "FROM chatops_turns WHERE conversation_id = ? AND seq > ?",
    ).get(SUMMARY_PREFIX.length, SUMMARY_PREFIX, MAIN_CONVERSATION_ID, from) as { newest: number | null; n: number; dms: number; summaries: number };
    const recent = db.prepare(
      `SELECT seq, role, content, surface FROM chatops_turns WHERE conversation_id = ? AND seq > ? AND ${DM} ORDER BY seq DESC LIMIT ?`,
    ).all(MAIN_CONVERSATION_ID, from, MAX_PULL) as unknown as Array<{ seq: number; role: string; content: string; surface: "discord" | "teams" }>;
    const earlierDm = db.prepare(`SELECT 1 FROM chatops_turns WHERE conversation_id = ? AND seq <= ? AND ${DM} LIMIT 1`).get(MAIN_CONVERSATION_ID, from);
    const meta = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(MAIN_CUTOVER_KEY) as { value: string } | undefined;
    const newest = stats.newest ?? from;
    const rows = recent.reverse().flatMap((r) => mapSyncedTurn({ role: r.role as ChatTurn["role"], content: r.content }, { kind: "dm" }, "")
      .map((row): MainDmRow => ({ seq: r.seq, via: r.surface, row })));
    // The cutover line goes with the first pull that has something for it to be about — the first DM
    // after the merge, or the folded summary — whatever desktop turns moved the cursor first. A fresh
    // install with no history gets none until its first DM.
    const line = !earlierDm && (stats.dms > 0 || stats.summaries > 0);
    return {
      rows, cursor: newest, trimmed: newest - from > stats.n || stats.dms > MAX_PULL,
      ...(meta && line ? { cutoverAt: meta.value } : {}),
    };
  } finally {
    db.exec("COMMIT");
  }
}

// Home's pull cursor (#1000), kept beside the thread by the host (memory_meta, plain KV): the shell
// stores it with each save, so a reopened Home pulls only what it hasn't shown.
const HOME_CURSOR_KEY = "mainConversationHomeCursor";

export function homeMainCursor(file: string): number {
  const row = openDb(file).prepare("SELECT value FROM memory_meta WHERE key = ?").get(HOME_CURSOR_KEY) as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function setHomeMainCursor(file: string, cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return;
  openDb(file).prepare(
    "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(HOME_CURSOR_KEY, String(cursor));
}
