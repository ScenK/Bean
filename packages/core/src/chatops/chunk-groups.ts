import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface ChunkGroups {
  /** Links the message ids of one text sent as several chunks, in send order. */
  record(ids: string[], now?: Date): void;
  /** The whole group a chunk belongs to, in send order, plus that chunk's position in it. */
  group(messageId: string): { ids: string[]; index: number } | undefined;
}

export function makeChunkGroups(opts: { dbPath: string }): ChunkGroups {
  const db: DatabaseSync = openDb(opts.dbPath);
  return {
    record(ids, now = new Date()): void {
      const first = ids[0];
      if (first === undefined) return;
      const at = now.getTime();
      db.exec("BEGIN IMMEDIATE");
      try {
        const ins = db.prepare("INSERT OR REPLACE INTO chatops_chunks (message_id, first_id, seq, at) VALUES (?, ?, ?, ?)");
        ids.forEach((id, seq) => ins.run(id, first, seq, at));
        // ponytail: fixed 30-day retention — a reply to an older chunk sees just that chunk; make it
        // configurable if people reply to month-old digests.
        db.prepare("DELETE FROM chatops_chunks WHERE at < ?").run(at - KEEP_MS);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    group(messageId) {
      const row = db.prepare("SELECT first_id AS firstId FROM chatops_chunks WHERE message_id = ?")
        .get(messageId) as { firstId: string } | undefined;
      if (!row) return undefined;
      const ids = (db.prepare("SELECT message_id AS id FROM chatops_chunks WHERE first_id = ? ORDER BY seq")
        .all(row.firstId) as { id: string }[]).map((r) => r.id);
      return { ids, index: ids.indexOf(messageId) };
    },
  };
}
