import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type { ChatTurn } from "../converse.js";

interface TurnRow { seq: number; role: string; content: string; created_at: string }

function toChatTurn(row: TurnRow): ChatTurn {
  return { role: row.role as ChatTurn["role"], content: row.content };
}

/** A stored turn with its row identity — the snapshot compaction hands back to replaceOldest. */
export interface StoredTurn extends ChatTurn { seq: number; createdAt: string }

/** Which surface wrote a turn into a conversation several of them share. */
export type TurnSurface = "desktop" | "discord" | "teams";

export interface AppendOpts {
  surface?: TurnSurface;
  /** Idempotency key, unique per conversation: a second append with the same key stores nothing. */
  turnKey?: string;
}

/** ConversationStore.append's write, for a caller already inside its own BEGIN IMMEDIATE on the same
 * bean.db (the Home drain, #997). False = `opts.turnKey` is already in this conversation. Fires no
 * onChange: the caller's own process isn't listening. */
export function insertTurn(db: DatabaseSync, conversationId: string, turn: ChatTurn, opts: AppendOpts = {}): boolean {
  if (opts.turnKey !== undefined &&
    db.prepare("SELECT 1 FROM chatops_turns WHERE conversation_id = ? AND turn_key = ?").get(conversationId, opts.turnKey)) {
    return false;
  }
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO chatops_turns (conversation_id, seq, role, content, created_at, surface, turn_key) " +
      "SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM chatops_turns WHERE conversation_id = ?",
  ).run(conversationId, turn.role, turn.content, now, opts.surface ?? null, opts.turnKey ?? null, conversationId);
  // Keeps the desktop's conversation list (chatops/catalog.ts) in recency order.
  db.prepare("UPDATE chatops_conversations SET updated_at = ? WHERE conversation_id = ?").run(now, conversationId);
  return true;
}

/** Moves a catalogued conversation's turns to a new archive id (`<id>~<uuid>`) with a copy of each
 * catalog row marked `archived_from` (read-only on the desktop; no model read ever names it). For a
 * caller inside its own BEGIN IMMEDIATE. Undefined = not catalogued or no turns: nothing moved. */
export function archiveTurns(db: DatabaseSync, conversationId: string): string | undefined {
  const has = (table: string): boolean =>
    !!db.prepare(`SELECT 1 FROM ${table} WHERE conversation_id = ? LIMIT 1`).get(conversationId);
  if (!has("chatops_conversations") || !has("chatops_turns")) return undefined;
  const archiveId = `${conversationId}~${randomUUID()}`;
  db.prepare("UPDATE chatops_turns SET conversation_id = ? WHERE conversation_id = ?").run(archiveId, conversationId);
  db.prepare(
    "INSERT INTO chatops_conversations (conversation_id, surface, kind, title, owner_id, owner_alt_id, live_cli, live_session_id, updated_at, archived_from) " +
      "SELECT ?, surface, kind, title, owner_id, owner_alt_id, live_cli, NULL, updated_at, conversation_id FROM chatops_conversations WHERE conversation_id = ?",
  ).run(archiveId, conversationId);
  return archiveId;
}

/** Per-thread chat history backed by the shared bean.db (chatops_turns table) — persists across
 * bot restarts, unlike the old in-memory Map. turnCount/oldest/replaceOldest back
 * chatops/compact.ts's silent summarization pass, which keeps long conversations bounded the
 * way the old MAX_TURNS slice did, just smarter. Safe for several processes writing one
 * conversation (host + bot servers): every write runs under BEGIN IMMEDIATE. */
export class ConversationStore {
  private db: DatabaseSync;
  private onChange?: (conversationId: string) => void;

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

  /** Runs `fn` under BEGIN IMMEDIATE: the write lock is taken up front (waiting out busy_timeout),
   * so a read-then-write inside can't race another process's write. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Appends `turn` at the next seq. Returns false — storing nothing — when `opts.turnKey` is
   * already in this conversation. */
  append(conversationId: string, turn: ChatTurn, opts: AppendOpts = {}): boolean {
    const stored = this.tx(() => insertTurn(this.db, conversationId, turn, opts));
    if (stored) this.changed(conversationId);
    return stored;
  }

  /** When the newest turn (highest seq) was written, or undefined for an empty conversation. */
  lastTurnAt(conversationId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT created_at FROM chatops_turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(conversationId) as { created_at: string } | undefined;
    return row?.created_at;
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
      archiveId = archiveTurns(db, conversationId);
      if (!archiveId) db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ?").run(conversationId);
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
    this.changed(conversationId);
    return archiveId;
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

  /** Oldest `n` turns, for summarizing before they're replaced — pass them back to replaceOldest. */
  oldest(conversationId: string, n: number): StoredTurn[] {
    return this.oldestRows(conversationId, n).map((r) => ({ ...toChatTurn(r), seq: r.seq, createdAt: r.created_at }));
  }

  private oldestRows(conversationId: string, n: number): TurnRow[] {
    return this.db.prepare(
      "SELECT seq, role, content, created_at FROM chatops_turns WHERE conversation_id = ? ORDER BY seq LIMIT ?",
    ).all(conversationId, n) as unknown as TurnRow[];
  }

  /** Compare-and-swap: replaces the `snapshot` turns (from oldest()) with `summary`, at the lowest
   * freed seq so it still sorts first — only if they are still exactly this conversation's oldest
   * rows. Another pass compacted them, or a /new reset the conversation, since the snapshot →
   * returns false and changes nothing. created_at in the match is what tells a reset's fresh turns
   * (seqs restart at 1) apart from the ones summarized. */
  replaceOldest(conversationId: string, snapshot: readonly StoredTurn[], summary: ChatTurn): boolean {
    const first = snapshot[0];
    if (!first) return false;
    const db = this.db;
    const replaced = this.tx(() => {
      const rows = this.oldestRows(conversationId, snapshot.length);
      const same = rows.length === snapshot.length && rows.every((r, i) => {
        const t = snapshot[i]!;
        return r.seq === t.seq && r.role === t.role && r.content === t.content && r.created_at === t.createdAt;
      });
      if (!same) return false;
      const del = db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ? AND seq = ?");
      for (const { seq } of snapshot) del.run(conversationId, seq);
      db.prepare(
        "INSERT INTO chatops_turns (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(conversationId, first.seq, summary.role, summary.content, new Date().toISOString());
      return true;
    });
    if (replaced) this.changed(conversationId);
    return replaced;
  }
}
