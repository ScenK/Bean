import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type { ChatTurn } from "../converse.js";

interface TurnRow { seq: number; role: string; content: string }

function toChatTurn(row: TurnRow): ChatTurn {
  return { role: row.role as ChatTurn["role"], content: row.content };
}

/** Per-thread chat history backed by the shared bean.db (chatops_turns table) — persists across
 * bot restarts, unlike the old in-memory Map. turnCount/oldest/replaceOldest back
 * chatops/compact.ts's silent summarization pass, which keeps long conversations bounded the
 * way the old MAX_TURNS slice did, just smarter. */
export class ConversationStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = openDb(file);
  }

  history(conversationId: string): ChatTurn[] {
    const rows = this.db.prepare(
      "SELECT seq, role, content FROM chatops_turns WHERE conversation_id = ? ORDER BY seq",
    ).all(conversationId) as unknown as TurnRow[];
    return rows.map(toChatTurn);
  }

  append(conversationId: string, turn: ChatTurn): void {
    const row = this.db.prepare(
      "SELECT MAX(seq) as maxSeq FROM chatops_turns WHERE conversation_id = ?",
    ).get(conversationId) as { maxSeq: number | null };
    const seq = (row.maxSeq ?? 0) + 1;
    this.db.prepare(
      "INSERT INTO chatops_turns (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(conversationId, seq, turn.role, turn.content, new Date().toISOString());
  }

  turnCount(conversationId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM chatops_turns WHERE conversation_id = ?",
    ).get(conversationId) as { c: number };
    return row.c;
  }

  /** Oldest `n` turns, for summarizing before they're replaced. */
  oldest(conversationId: string, n: number): ChatTurn[] {
    const rows = this.db.prepare(
      "SELECT seq, role, content FROM chatops_turns WHERE conversation_id = ? ORDER BY seq LIMIT ?",
    ).all(conversationId, n) as unknown as TurnRow[];
    return rows.map(toChatTurn);
  }

  /** Deletes the oldest `n` turns and inserts `summary` in their place (at the lowest freed
   * seq, so it still sorts before what's kept). */
  replaceOldest(conversationId: string, n: number, summary: ChatTurn): void {
    const rows = this.db.prepare(
      "SELECT seq FROM chatops_turns WHERE conversation_id = ? ORDER BY seq LIMIT ?",
    ).all(conversationId, n) as unknown as { seq: number }[];
    if (rows.length === 0) return;
    const minSeq = rows[0]!.seq;
    this.db.exec("BEGIN");
    try {
      const del = this.db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ? AND seq = ?");
      for (const { seq } of rows) del.run(conversationId, seq);
      this.db.prepare(
        "INSERT INTO chatops_turns (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(conversationId, minSeq, summary.role, summary.content, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
