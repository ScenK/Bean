// packages/core/src/home-posts.ts
// Sprout posts for the desktop's Home chat (#959): `sinks.home` leaves one row per delivered run
// in `bean.db`'s `home_posts`; a shell drains the pending ones into its Home transcript. Written
// only by the scheduler-lease holder (routine-host.ts).
import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { saveDesktopChat, type DesktopChatInput } from "./desktop-chats.js";
import { insertTurn } from "./chatops/conversation.js";
import { MAIN_CONVERSATION_ID, postTurnKey } from "./main-conversation.js";
import { postTurn } from "./prompt.js";
import { ownerDmSinkTransports, type RoutineChatopsSink } from "./routine-store.js";

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

/** A post's stored body: capped at HOME_POST_MAX_CHARS with a Dashboard tail. The owner-DM copy
 * (#1067) uses it too, so its main-log turn matches the drain's byte for byte. */
export const homePostBody = (body: string): string =>
  body.length > HOME_POST_MAX_CHARS ? body.slice(0, HOME_POST_MAX_CHARS - CUT_TAIL.length) + CUT_TAIL : body;

/** Who wrote a Home post: a sprout's `sinks.home` digest, or Bean's own proactive check-in. */
export type HomePostKind = "sprout" | "pulse";

/** Adds one pending post (`ttlMinutes` = expires that long after now) and drops the oldest
 * undrained rows past HOME_PENDING_CAP. Returns the post id. */
export function insertHomePost(
  file: string, p: { sprout: string; body: string; ttlMinutes?: number; kind?: HomePostKind },
  newId: () => string = randomUUID, now: () => Date = () => new Date(),
): string {
  const id = newId();
  const at = now();
  const body = homePostBody(p.body);
  const expires = p.ttlMinutes !== undefined ? new Date(at.getTime() + p.ttlMinutes * 60_000).toISOString() : null;
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO home_posts (id, sprout, body, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.sprout, body, at.toISOString(), expires, p.kind ?? "sprout");
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

/** When the soonest pending post expires (ISO), or undefined when none will: the host's bubble
 * recounts then, so the last post expiring clears it with no other event (#961). */
export function nextHomePostExpiry(file: string, now: () => Date = () => new Date()): string | undefined {
  const r = openDb(file).prepare(`SELECT MIN(expires_at) AS at FROM home_posts WHERE ${PENDING} AND expires_at IS NOT NULL`)
    .get(now().toISOString()) as { at: string | null };
  return r.at ?? undefined;
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

/** Saves a Home transcript and marks the posts it now holds drained, in one transaction: a failed
 * save leaves them pending, and a crash can't drain a post the transcript doesn't hold. Returns the
 * stored title. `mainLog` (after the cutover, #997): each drained post is also appended to the main
 * conversation's log, keyed by its id — a re-run drain appends it once. */
export function saveDesktopChatDraining(
  file: string, chat: DesktopChatInput, drained: readonly string[], now: Date = new Date(), opts: { mainLog?: boolean } = {},
): string {
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const title = saveDesktopChat(file, chat, now);
    // Only posts this save drains: a replayed drain must not re-add one compaction already folded away.
    const get = db.prepare("SELECT sprout, body FROM home_posts WHERE id = ? AND drained_at IS NULL");
    const fresh = opts.mainLog ? drained.flatMap((id) => {
      const p = get.get(id) as { sprout: string; body: string } | undefined;
      return p ? [{ id, ...p }] : [];
    }) : [];
    markHomePostsDrained(file, drained, () => now);
    for (const p of fresh) {
      insertTurn(db, MAIN_CONVERSATION_ID, { role: "user", content: postTurn({ sprout: p.sprout, text: p.body }) }, { surface: "desktop", turnKey: postTurnKey(p.id) });
    }
    db.exec("COMMIT");
    return title;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** memory_meta marker of the owner-DM sink migration (#1068); its value is when it ran. */
export const HOME_DM_MIGRATION_KEY = "homeDmSinksMigratedAt";

/** Once per data dir, by the scheduler-lease holder: the surfaces whose owner DM a sprout still
 * named (raw files — load folds those sinks into Home) get their "Home posts also go to this DM"
 * toggle turned on through `enable`, then the marker is written. A failed `enable` throws and writes
 * no marker (the next lease take retries); with the marker present nothing runs again, so a toggle
 * the owner turns off later stays off. The files are read before the first await. */
export async function migrateOwnerDmSinks(
  routinesDir: string, file: string,
  enable: (transports: RoutineChatopsSink["transport"][]) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<"done" | "already"> {
  const db = openDb(file);
  if (db.prepare("SELECT 1 FROM memory_meta WHERE key = ?").get(HOME_DM_MIGRATION_KEY) !== undefined) return "already";
  const transports = ownerDmSinkTransports(routinesDir);
  if (transports.length > 0) await enable(transports);
  db.prepare("INSERT OR IGNORE INTO memory_meta (key, value) VALUES (?, ?)").run(HOME_DM_MIGRATION_KEY, now().toISOString());
  return "done";
}
