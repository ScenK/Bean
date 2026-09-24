import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type { ChatTurn } from "../converse.js";

interface TurnRow { seq: number; role: string; content: string }

/** Archived sessions kept per conversation; older ones are deleted on the next archive. */
export const MAX_ARCHIVED_SESSIONS = 10;

/** An archived (post-`/new`) session, as listed by `/sessions`. */
export interface ArchivedSession {
  key: string;
  lastActive: string;
  turns: number;
  preview: string;
}

// Archived sessions live in the same table under `<conversationId>#archived:<iso>:<rand>` —
// resuming is a rename back, no schema change.
const archivePrefix = (conversationId: string): string => `${conversationId}#archived:`;

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

  /** Deletes a conversation's entire history. */
  clear(conversationId: string): void {
    this.db.prepare("DELETE FROM chatops_turns WHERE conversation_id = ?").run(conversationId);
  }

  /** Moves the live history into a new archived session (backs "/new" and "/resume"), then
   * trims archives beyond MAX_ARCHIVED_SESSIONS. No-op on an empty conversation. */
  archive(conversationId: string): void {
    this.moveToArchive(conversationId);
    this.trimArchive(conversationId);
  }

  private moveToArchive(conversationId: string): void {
    if (this.turnCount(conversationId) === 0) return;
    const key = `${archivePrefix(conversationId)}${new Date().toISOString()}:${randomUUID().slice(0, 8)}`;
    this.db.prepare("UPDATE chatops_turns SET conversation_id = ? WHERE conversation_id = ?").run(key, conversationId);
  }

  private trimArchive(conversationId: string): void {
    for (const old of this.archived(conversationId).slice(MAX_ARCHIVED_SESSIONS)) this.clear(old.key);
  }

  /** Archived sessions for this conversation, most recently archived first (the key embeds the
   * archive time) — so a just-resumed-then-re-archived session isn't the first one trimmed. */
  archived(conversationId: string): ArchivedSession[] {
    const prefix = archivePrefix(conversationId);
    const rows = this.db.prepare(
      "SELECT conversation_id AS key, MAX(created_at) AS lastActive, COUNT(*) AS turns, " +
        "(SELECT content FROM chatops_turns u WHERE u.conversation_id = t.conversation_id AND u.role = 'user' ORDER BY seq LIMIT 1) AS preview " +
        "FROM chatops_turns t WHERE substr(conversation_id, 1, ?) = ? GROUP BY conversation_id ORDER BY key DESC",
    ).all(prefix.length, prefix) as unknown as (Omit<ArchivedSession, "preview"> & { preview: string | null })[];
    return rows.map((r) => ({ ...r, preview: r.preview ?? "" }));
  }

  /** Swaps archived session `index` (0-based, as ordered by `archived()`) in as the live
   * history, archiving the current one. Returns false for an out-of-range index. */
  resume(conversationId: string, index: number): boolean {
    const target = this.archived(conversationId)[index];
    if (!target) return false;
    this.db.exec("BEGIN");
    try {
      // Trim only after the target is live again — trimming first could delete it when it's the oldest.
      this.moveToArchive(conversationId);
      this.db.prepare("UPDATE chatops_turns SET conversation_id = ? WHERE conversation_id = ?").run(conversationId, target.key);
      this.trimArchive(conversationId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return true;
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

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function sessionList(store: ConversationStore, conversationId: string): string {
  const sessions = store.archived(conversationId);
  if (sessions.length === 0) return "No saved sessions yet — `/new` saves the current one before starting fresh.";
  const lines = sessions.map((s, i) =>
    `${i + 1}. ${new Date(s.lastActive).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${s.turns} turns · ${clip(s.preview, 80) || "(no user message)"}`);
  return `Saved sessions (resume with \`/resume <n>\`):\n${lines.join("\n")}`;
}

/** Handles the session keyword commands shared by every chatops surface — `new`, `sessions`,
 * `resume [n]` — given the slash-stripped, lowercased command text. Returns the reply, or
 * undefined when `cmd` isn't one of them. Callers also fence ambient chatter (setAmbientCutoff)
 * so messages from the replaced session can't leak into the new one. */
export function sessionCommand(store: ConversationStore, conversationId: string, cmd: string): string | undefined {
  if (cmd === "new") {
    store.archive(conversationId);
    store.setAmbientCutoff(conversationId, Date.now());
    return "Fresh start — previous conversation saved. `/sessions` lists saved ones, `/resume <n>` brings one back.";
  }
  if (cmd === "sessions" || cmd === "resume") return sessionList(store, conversationId);
  const m = /^resume\s+(\d+)$/.exec(cmd);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!store.resume(conversationId, n - 1)) return `No session ${n}.\n\n${sessionList(store, conversationId)}`;
  store.setAmbientCutoff(conversationId, Date.now());
  // Discord/Teams can't un-show the chat on screen, so recap what the model now remembers.
  const recap = store.history(conversationId).filter((t) => t.role !== "system").slice(-3)
    .map((t) => `> **${t.role === "user" ? "You" : "Bean"}:** ${clip(t.content, 200)}`);
  return `Resumed session ${n}. Picking up from:\n${recap.join("\n")}`;
}
