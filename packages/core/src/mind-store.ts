import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";

// Seeds (#1156): Bean's own short working list, kept by the proactive pulse (pulse.ts) and crossed
// off by the owner. Every write bumps `version`; a pulse commit carries the versions it read, so the
// owner's Done / Let it go between that read and the commit always wins (the pulse's write misses).

export type MindStatus = "active" | "done" | "dismissed" | "expired";
/** Why the owner let a seed go (optional). */
export type DismissReason = "not-interested" | "wrong";

export interface MindItem {
  id: string;
  /** The pulse's stable handle for the topic: a repeat of it rewords the active row, never adds one. */
  topicKey: string;
  /** One line in Bean's voice. */
  text: string;
  /** Short evidence kept from the run that raised it — sprout history rolls off after 20 runs. */
  excerpt?: string;
  sourceSprout?: string;
  /** The source run's `startedAt` (its Dashboard link). */
  sourceStartedAt?: string;
  status: MindStatus;
  dismissReason?: DismissReason;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextReviewAt?: string;
  lastNudgedAt?: string;
  suppressedUntil?: string;
  /** When the pulse last wrote the row; an `updatedAt` past it = the owner touched it since. */
  reconciledAt?: string;
}

export const MIND_ACTIVE_CAP = 10;
/** Terminal rows (done/dismissed/expired) are deleted this long after their last update. */
export const MIND_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
const TEXT_MAX = 300;
const EXCERPT_MAX = 500;

interface Row {
  id: string; topic_key: string; text: string; excerpt: string | null; source_sprout: string | null;
  source_started_at: string | null; status: string; dismiss_reason: string | null; version: number;
  created_at: string; updated_at: string; next_review_at: string | null; last_nudged_at: string | null;
  suppressed_until: string | null; reconciled_at: string | null;
}

const COLS = "id, topic_key, text, excerpt, source_sprout, source_started_at, status, dismiss_reason, version, " +
  "created_at, updated_at, next_review_at, last_nudged_at, suppressed_until, reconciled_at";

function toItem(r: Row): MindItem {
  return {
    id: r.id, topicKey: r.topic_key, text: r.text, status: r.status as MindStatus, version: r.version,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.excerpt ? { excerpt: r.excerpt } : {}),
    ...(r.source_sprout ? { sourceSprout: r.source_sprout } : {}),
    ...(r.source_started_at ? { sourceStartedAt: r.source_started_at } : {}),
    ...(r.dismiss_reason ? { dismissReason: r.dismiss_reason as DismissReason } : {}),
    ...(r.next_review_at ? { nextReviewAt: r.next_review_at } : {}),
    ...(r.last_nudged_at ? { lastNudgedAt: r.last_nudged_at } : {}),
    ...(r.suppressed_until ? { suppressedUntil: r.suppressed_until } : {}),
    ...(r.reconciled_at ? { reconciledAt: r.reconciled_at } : {}),
  };
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

function inTx<T>(file: string, fn: () => T): T {
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Active seeds (oldest first), plus terminal ones updated in the last `recentDays` (default none). */
export function listMindItems(file: string, opts: { recentDays?: number; now?: Date } = {}): MindItem[] {
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.recentDays ?? 0) * DAY_MS).toISOString();
  return (openDb(file).prepare(
    `SELECT ${COLS} FROM mind_items WHERE status = 'active' OR updated_at >= ? ORDER BY status = 'active' DESC, created_at, rowid`,
  ).all(since) as unknown as Row[]).map(toItem);
}

export function getMindItem(file: string, id: string): MindItem | undefined {
  const r = openDb(file).prepare(`SELECT ${COLS} FROM mind_items WHERE id = ?`).get(id) as Row | undefined;
  return r ? toItem(r) : undefined;
}

export interface PulseSeed {
  topicKey: string;
  text: string;
  excerpt?: string;
  sourceSprout?: string;
  sourceStartedAt?: string;
  nextReviewAt?: string;
}

/** What one pulse decided, against the rows (and versions) it read. */
export interface PulsePlan {
  /** A new topic, or `id` + `version` = reword that active row. */
  upserts: (PulseSeed & { id?: string; version?: number })[];
  /** The pulse never dismisses — that is the owner's word. */
  resolve: { id: string; version: number; status: "done" | "expired" }[];
}

export interface PlanOutcome { added: string[]; updated: string[]; resolved: string[]; conflicts: string[] }

/** Commits a pulse's plan in one transaction. A versioned write that misses (the owner, or another
 * pulse, changed the row since the read) is skipped and listed in `conflicts`. A new topic is skipped
 * at the active cap, when an active row has its key, when the owner let it go, or when it was done
 * and the evidence isn't a run that started after. Also prunes terminal rows past retention. */
export function applyPulsePlan(
  file: string, plan: PulsePlan, now: Date = new Date(), newId: () => string = randomUUID,
): PlanOutcome {
  const at = now.toISOString();
  const out: PlanOutcome = { added: [], updated: [], resolved: [], conflicts: [] };
  return inTx(file, () => {
    const db = openDb(file);
    db.prepare("DELETE FROM mind_items WHERE status <> 'active' AND updated_at < ?")
      .run(new Date(now.getTime() - MIND_RETENTION_DAYS * DAY_MS).toISOString());
    const resolve = db.prepare(
      "UPDATE mind_items SET status = ?, version = version + 1, updated_at = ?, reconciled_at = ? WHERE id = ? AND version = ? AND status = 'active'",
    );
    for (const r of plan.resolve) {
      if (Number(resolve.run(r.status, at, at, r.id, r.version).changes) > 0) out.resolved.push(r.id);
      else out.conflicts.push(r.id);
    }
    const reword = db.prepare(
      "UPDATE mind_items SET text = ?, excerpt = COALESCE(?, excerpt), next_review_at = COALESCE(?, next_review_at), " +
        "version = version + 1, updated_at = ?, reconciled_at = ? WHERE id = ? AND version = ? AND status = 'active'",
    );
    const byKey = db.prepare("SELECT status, updated_at FROM mind_items WHERE topic_key = ?");
    const activeCount = db.prepare("SELECT COUNT(*) AS n FROM mind_items WHERE status = 'active'");
    const insert = db.prepare(
      `INSERT INTO mind_items (id, topic_key, text, excerpt, source_sprout, source_started_at, status, version, created_at, updated_at, next_review_at, reconciled_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    );
    for (const u of plan.upserts) {
      const text = clip(u.text, TEXT_MAX);
      const excerpt = u.excerpt ? clip(u.excerpt, EXCERPT_MAX) : null;
      if (!text || !u.topicKey) continue;
      if (u.id !== undefined) {
        if (Number(reword.run(text, excerpt, u.nextReviewAt ?? null, at, at, u.id, u.version ?? -1).changes) > 0) out.updated.push(u.id);
        else out.conflicts.push(u.id);
        continue;
      }
      const prior = byKey.all(u.topicKey) as { status: string; updated_at: string }[];
      const blocked = prior.some((p) => p.status === "active" || p.status === "dismissed" ||
        (p.status === "done" && !(u.sourceStartedAt && u.sourceStartedAt > p.updated_at)));
      if (blocked || (activeCount.get() as { n: number }).n >= MIND_ACTIVE_CAP) continue;
      const id = newId();
      insert.run(id, u.topicKey, text, excerpt, u.sourceSprout ?? null, u.sourceStartedAt ?? null, at, at, u.nextReviewAt ?? null, at);
      out.added.push(id);
    }
    return out;
  });
}

/** The owner's Done / Let it go: no version check — the owner always wins. Only an active seed
 * changes; returns the updated row, or undefined when it wasn't active. */
export function resolveMindItem(
  file: string, id: string, status: "done" | "dismissed", reason?: DismissReason, now: Date = new Date(),
): MindItem | undefined {
  const changed = Number(openDb(file).prepare(
    "UPDATE mind_items SET status = ?, dismiss_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'active'",
  ).run(status, status === "dismissed" ? reason ?? null : null, now.toISOString(), id).changes);
  return changed > 0 ? getMindItem(file, id) : undefined;
}

/** Undo of a Done / Let it go, or of the pulse crossing one off from a reply: back to active. */
export function undoMindItem(file: string, id: string, now: Date = new Date()): MindItem | undefined {
  const changed = Number(openDb(file).prepare(
    "UPDATE mind_items SET status = 'active', dismiss_reason = NULL, version = version + 1, updated_at = ? " +
      "WHERE id = ? AND status IN ('done', 'dismissed', 'expired')",
  ).run(now.toISOString(), id).changes);
  return changed > 0 ? getMindItem(file, id) : undefined;
}

/** The owner touched a seed (Done, Let it go, Undo) after `since` (ISO): an answer to a check-in. */
export function ownerTouchedSeedSince(file: string, since: string): boolean {
  return openDb(file).prepare(
    "SELECT 1 FROM mind_items WHERE updated_at > ? AND (reconciled_at IS NULL OR updated_at > reconciled_at) LIMIT 1",
  ).get(since) !== undefined;
}

/** Bean's own check-ins (`home_posts.kind = 'pulse'`) since local midnight of `now`. */
export function countPulsePostsToday(file: string, now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  return (openDb(file).prepare("SELECT COUNT(*) AS n FROM home_posts WHERE kind = 'pulse' AND created_at >= ?")
    .get(midnight) as { n: number }).n;
}
