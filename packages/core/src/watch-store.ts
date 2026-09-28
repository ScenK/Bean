import { openDb } from "./db.js";

// A watch's seen-set lives in bean.db (not .state.json): insert-or-ignore is atomic, and the
// cap/cascade are plain SQL. `watch_source` records which source the set was seeded from — a
// different url/command (panel edit or hand edit) wipes the set so it re-seeds, and "seeded"
// is explicit, so a source that was empty at seed time still counts as seeded.

export const WATCH_SEEN_CAP = 500;

/** True when the seen-set was seeded from `source`. A mismatched source is cleared here. */
export function isWatchSeeded(file: string, routine: string, source: string): boolean {
  const db = openDb(file);
  const row = db.prepare("SELECT source FROM watch_source WHERE routine = ?").get(routine) as unknown as { source: string } | undefined;
  if (!row) return false;
  if (row.source === source) return true;
  clearWatch(file, routine);
  return false;
}

/** First poll (or Enable): record every current item as seen, fire nothing. */
export function seedWatch(file: string, routine: string, source: string, ids: string[], now: () => Date = () => new Date()): void {
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM watch_seen WHERE routine = ?").run(routine);
    db.prepare("INSERT OR REPLACE INTO watch_source (routine, source) VALUES (?, ?)").run(routine, source);
    const ins = db.prepare("INSERT OR IGNORE INTO watch_seen (routine, item_id, seen_at) VALUES (?, ?, ?)");
    const at = now().toISOString();
    for (const id of ids) ins.run(routine, id, at);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Records `ids` as seen and returns the ones that weren't already — in input order. Keeps the
 * newest `max(500, 2 × ids.length)` rows so a feed's current page is never evicted. */
export function markNewItems(file: string, routine: string, ids: string[], now: () => Date = () => new Date()): string[] {
  const db = openDb(file);
  const fresh: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    // Still-present items get their seen_at refreshed, so the cap below only ever evicts ids
    // that dropped out of the source — never one the next poll would see as "new" again.
    const touch = db.prepare("UPDATE watch_seen SET seen_at = ? WHERE routine = ? AND item_id = ?");
    const ins = db.prepare("INSERT OR IGNORE INTO watch_seen (routine, item_id, seen_at) VALUES (?, ?, ?)");
    const at = now().toISOString();
    for (const id of ids) {
      if (Number(touch.run(at, routine, id).changes) > 0) continue;
      if (Number(ins.run(routine, id, at).changes) > 0) fresh.push(id);
    }
    const cap = Math.max(WATCH_SEEN_CAP, 2 * ids.length);
    db.prepare(
      "DELETE FROM watch_seen WHERE routine = ? AND rowid NOT IN " +
      "(SELECT rowid FROM watch_seen WHERE routine = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?)",
    ).run(routine, routine, cap);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return fresh;
}

export function countSeen(file: string, routine: string): number {
  const row = openDb(file).prepare("SELECT COUNT(*) AS n FROM watch_seen WHERE routine = ?").get(routine) as unknown as { n: number };
  return Number(row.n);
}

/** Routine deleted (or source changed): drop its seen-set and seed marker. */
export function clearWatch(file: string, routine: string): void {
  const db = openDb(file);
  db.prepare("DELETE FROM watch_seen WHERE routine = ?").run(routine);
  db.prepare("DELETE FROM watch_source WHERE routine = ?").run(routine);
}
