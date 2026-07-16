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

  /** Deletes a conversation's entire history — backs the "/new" fresh-start command. */
  clear(conversationId: string): void {
    this.db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ?").run(conversationId);
  }

  /** Epoch ms of the newest ambient message already injected here; 0 when none. Durable
   * (not per-process) so a restarted bot doesn't re-inject chatter Discord still returns
   * from live channel history — see the table's comment in db.ts. */
  ambientCutoff(conversationId: string): number {
    const row = this.db.prepare(
      "SELECT cutoff_ms FROM chatops_ambient_cutoff WHERE conversation_id = ?",
    ).get(conversationId) as { cutoff_ms: number } | undefined;
    return row?.cutoff_ms ?? 0;
  }

  setAmbientCutoff(conversationId: string, cutoffMs: number): void {
    this.db.prepare(
      "INSERT INTO chatops_ambient_cutoff (conversation_id, cutoff_ms) VALUES (?, ?) " +
        "ON CONFLICT(conversation_id) DO UPDATE SET cutoff_ms = excluded.cutoff_ms",
    ).run(conversationId, cutoffMs);
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
