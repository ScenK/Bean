// packages/core/src/home-posts.ts
// Sprout posts for the desktop's Home chat (#959): `sinks.home` leaves one row per delivered run
// in `bean.db`'s `home_posts`; a shell drains the pending ones into its Home transcript. Written
// only by the scheduler-lease holder (routine-host.ts).
import { createHash, randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { saveDesktopChat, type DesktopChatInput } from "./desktop-chats.js";

export interface HomePost {
  id: string;
  sprout: string;
  body: string;
  createdAt: string;
  /** Absent = never expires. */
  expiresAt?: string;
}

/** The renderer's per-text transcript cap (chat-thread.ts THREAD_TEXT_MAX) — keep in step, so a
 * drained post is never cut again. */
export const HOME_POST_MAX_CHARS = 20_000;
const CUT_TAIL = "\n\n… (cut — full digest in Dashboard)";
/** Undrained rows kept (newest win), so a core no shell ever drains stays bounded. */
export const HOME_PENDING_CAP = 50;
/** Drained rows are only bookkeeping: pruned this long after their drain. */
const DRAINED_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface HomePostRow { id: string; sprout: string; body: string; created_at: string; expires_at: string | null }

const toPost = (r: HomePostRow): HomePost => ({
  id: r.id, sprout: r.sprout, body: r.body, createdAt: r.created_at,
  ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
});

const PENDING = "drained_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

/** Adds one pending post (`ttlMinutes` = expires that long after now) and drops the oldest
 * undrained rows past HOME_PENDING_CAP. Returns the post id. */
export function insertHomePost(
  file: string, p: { sprout: string; body: string; ttlMinutes?: number },
  newId: () => string = randomUUID, now: () => Date = () => new Date(),
): string {
  const id = newId();
  const at = now();
  const body = p.body.length > HOME_POST_MAX_CHARS ? p.body.slice(0, HOME_POST_MAX_CHARS - CUT_TAIL.length) + CUT_TAIL : p.body;
  const expires = p.ttlMinutes !== undefined ? new Date(at.getTime() + p.ttlMinutes * 60_000).toISOString() : null;
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO home_posts (id, sprout, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, p.sprout, body, at.toISOString(), expires);
    db.prepare(
      "DELETE FROM home_posts WHERE drained_at IS NULL AND id NOT IN " +
      "(SELECT id FROM home_posts WHERE drained_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    ).run(HOME_PENDING_CAP);
    db.prepare("DELETE FROM home_posts WHERE drained_at < ?").run(new Date(at.getTime() - DRAINED_RETENTION_MS).toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return id;
}

/** Undrained, unexpired posts, oldest first. */
export function listPendingHomePosts(file: string, now: () => Date = () => new Date()): HomePost[] {
  return (openDb(file).prepare(`SELECT id, sprout, body, created_at, expires_at FROM home_posts WHERE ${PENDING} ORDER BY created_at, rowid`)
    .all(now().toISOString()) as unknown as HomePostRow[]).map(toPost);
}

export function countPendingHomePosts(file: string, now: () => Date = () => new Date()): number {
  return (openDb(file).prepare(`SELECT COUNT(*) AS n FROM home_posts WHERE ${PENDING}`).get(now().toISOString()) as { n: number }).n;
}

/** Marks `ids` drained. Idempotent: an already-drained or unknown id changes nothing. Returns how
 * many rows this call drained. */
export function markHomePostsDrained(file: string, ids: readonly string[], now: () => Date = () => new Date()): number {
  if (ids.length === 0) return 0;
  const stmt = openDb(file).prepare("UPDATE home_posts SET drained_at = ? WHERE id = ? AND drained_at IS NULL");
  const at = now().toISOString();
  let n = 0;
  for (const id of ids) n += Number(stmt.run(at, id).changes);
  return n;
}

/** The core-local calendar day of `now`, `YYYY-MM-DD`. */
const localDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Today's Home thread id (#960): a UUID-shaped hash of the core-local date, so every shell of this
 * core lands in the same thread and a new day starts a new one with no stored state. */
export function homeThreadId(now: Date = new Date()): string {
  const h = createHash("sha256").update(`bean:home:${localDay(now)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Today's Home thread title, e.g. "Home · Nov 19" (core-local day). */
export const homeThreadTitle = (now: Date = new Date()): string =>
  `Home · ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

/** When today's Home stops being today's: the next core-local midnight. */
export const nextHomeDay = (now: Date = new Date()): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

/** Saves a Home transcript and marks the posts it now holds drained, in one transaction: a failed
 * save leaves them pending, and a crash can't drain a post the transcript doesn't hold. Returns the
 * stored title. */
export function saveDesktopChatDraining(file: string, chat: DesktopChatInput, drained: readonly string[], now: Date = new Date()): string {
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const title = saveDesktopChat(file, chat, now);
    markHomePostsDrained(file, drained, () => now);
    db.exec("COMMIT");
    return title;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
