import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";

export const DAILY_TURN_CAP = 200;

/** The calendar date in the process's TZ (Node honors the TZ env var), e.g. "2026-10-13". */
export function localDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The TZ name shown in the cap reply ("resets at midnight (America/New_York)"). */
export function localTimeZone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface TurnCap {
  /** Counts the turn unless the speaker already has `cap` today. A repeated `turnId` (a platform
   * redelivery) is admitted again without counting. Atomic: parallel turns can't pass the cap. */
  admit(turn: { turnId: string; userId: string; userName: string }, now?: Date): boolean;
  /** Today's admitted turns per speaker, busiest first. */
  usage(now?: Date): { userId: string; name: string; count: number }[];
}

export function makeTurnCap(opts: { dbPath: string; surface: string; cap?: number }): TurnCap {
  const db: DatabaseSync = openDb(opts.dbPath);
  const cap = opts.cap ?? DAILY_TURN_CAP;
  return {
    admit({ turnId, userId, userName }, now = new Date()): boolean {
      const day = localDay(now);
      // One statement, so SQLite's write lock makes the count check and the insert atomic.
      const inserted = Number(db.prepare(
        `INSERT OR IGNORE INTO chatops_turn_counts (surface, turn_id, user_id, user_name, day)
         SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM chatops_turn_counts
           WHERE surface = ? AND day = ? AND user_id = ?) < ?`,
      ).run(opts.surface, turnId, userId, userName, day, opts.surface, day, userId, cap).changes);
      if (inserted > 0) {
        db.prepare("DELETE FROM chatops_turn_counts WHERE surface = ? AND day < ?").run(opts.surface, day);
        return true;
      }
      // Not inserted: either a redelivery of an already-counted turn, or the speaker is at the cap.
      return db.prepare("SELECT 1 FROM chatops_turn_counts WHERE surface = ? AND turn_id = ?")
        .get(opts.surface, turnId) !== undefined;
    },
    usage(now = new Date()) {
      return db.prepare(
        `SELECT user_id AS userId, MAX(user_name) AS name, COUNT(*) AS count FROM chatops_turn_counts
         WHERE surface = ? AND day = ? GROUP BY user_id ORDER BY count DESC`,
      ).all(opts.surface, localDay(now)) as { userId: string; name: string; count: number }[];
    },
  };
}
