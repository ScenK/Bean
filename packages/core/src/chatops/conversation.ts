import { randomUUID } from "node:crypto";
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
  private onChange?: (conversationId: string) => void;
  // ponytail: in-process, like compact.ts's inFlight map — one bot process owns a conversation.
  private clears = new Map<string, number>();

  /** `onChange` fires after every history write (append, replaceOldest, clear) — the one place
   * every writer (bot turns, delegate results, compaction, outbox notices) goes through. */
  constructor(file: string, opts: { onChange?: (conversationId: string) => void } = {}) {
    this.db = openDb(file);
    this.onChange = opts.onChange;
  }

  // A throwing listener must not fail the write it reports.
  private changed(conversationId: string): void {
    try {
      this.onChange?.(conversationId);
    } catch (err) {
      console.warn("bean: conversation change hook failed:", err instanceof Error ? err.name : "error");
    }
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
    // Keeps the desktop's conversation list (chatops/catalog.ts) in recency order.
    this.db.prepare("UPDATE chatops_conversations SET updated_at = ? WHERE conversation_id = ?")
      .run(new Date().toISOString(), conversationId);
    this.changed(conversationId);
  }

  /** Empties a conversation's history — backs the "/new" fresh-start command. A catalogued
   * conversation (chatops/catalog.ts) with turns keeps them for the desktop: they move to a new
   * archive id (`<id>~<uuid>`) with a copy of each catalog row marked `archived_from`, which no
   * model read ever names. Anything else is hard-deleted. Its resumable delegate sessions and its
   * catalog live binding go either way: a fresh start shouldn't resume the old agent. All or
   * nothing. Returns the archive id when one was made. */
  clear(conversationId: string): string | undefined {
    const db = this.db;
    let archiveId: string | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      const has = (table: string): boolean =>
        !!db.prepare(`SELECT 1 FROM ${table} WHERE conversation_id = ? LIMIT 1`).get(conversationId);
      if (has("chatops_conversations") && has("chatops_turns")) {
        archiveId = `${conversationId}~${randomUUID()}`;
        db.prepare("UPDATE chatops_turns SET conversation_id = ? WHERE conversation_id = ?").run(archiveId, conversationId);
        db.prepare(
          "INSERT INTO chatops_conversations (conversation_id, surface, kind, title, owner_id, owner_alt_id, live_cli, live_session_id, updated_at, archived_from) " +
            "SELECT ?, surface, kind, title, owner_id, owner_alt_id, live_cli, NULL, updated_at, conversation_id FROM chatops_conversations WHERE conversation_id = ?",
        ).run(archiveId, conversationId);
      } else {
        db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ?").run(conversationId);
      }
      db.prepare("DELETE FROM thread_sessions WHERE conversation_id = ?").run(conversationId);
      // Bumped on archive so the fresh conversation lists above its archive.
      db.prepare(
        `UPDATE chatops_conversations SET live_cli = NULL, live_session_id = NULL${archiveId ? ", updated_at = ?" : ""} WHERE conversation_id = ?`,
      ).run(...(archiveId ? [new Date().toISOString(), conversationId] : [conversationId]));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.clears.set(conversationId, this.clearCount(conversationId) + 1);
    this.changed(conversationId);
    return archiveId;
  }

  /** Bumped by every clear() — lets a writer that awaited (compaction) tell the history it read
   * from apart from a fresh one with reused seqs. */
  clearCount(conversationId: string): number {
    return this.clears.get(conversationId) ?? 0;
  }

  /** The CLI's own session id from this thread's last delegate run with that CLI, if any. */
  threadSession(conversationId: string, cli: string): string | undefined {
    const row = this.db.prepare(
      "SELECT session_id FROM thread_sessions WHERE conversation_id = ? AND cli = ?",
    ).get(conversationId, cli) as { session_id: string } | undefined;
    return row?.session_id;
  }

  setThreadSession(conversationId: string, cli: string, sessionId: string): void {
    this.db.prepare(
      "INSERT INTO thread_sessions (conversation_id, cli, session_id, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(conversation_id, cli) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at",
    ).run(conversationId, cli, sessionId, new Date().toISOString());
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
    this.changed(conversationId);
  }
}
