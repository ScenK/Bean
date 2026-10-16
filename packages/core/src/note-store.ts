import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import type { ActionTool } from "./converse.js";

/** A saved note: conversation output parked for later. Unlike memories, notes are never
 * injected into prompts — they do nothing until the user explicitly continues one in chat. */
export interface Note {
  slug: string;
  title: string;
  /** Markdown body. */
  body: string;
  /** Project path this note belongs to; absent = general. */
  project?: string;
  /** ISO timestamp of the last save. */
  updated: string;
  version: number;
  source: "chat" | "manual";
  /** Unchecked `- [ ]` items in the body — the "open questions" count. */
  openCount: number;
  /** Pinned by the user — sorts to the top of the list. */
  starred: boolean;
  /** ISO timestamp the note was archived; absent = live. */
  archivedAt?: string;
}

export interface NoteDraft {
  title: string;
  body: string;
  project?: string;
  source?: "chat" | "manual";
  /** Present = update that note in place (version bump, prior version kept in notes_history).
   * Slugs are opaque IDs: an update to a missing or archived slug throws (see saveNote's `upsert`). */
  slug?: string;
}

export function openQuestionCount(body: string): number {
  return (body.match(/^\s*[-*] \[ \]/gm) ?? []).length;
}

const traversal = /[/\\]|\.\./;

interface NoteRow {
  slug: string; title: string; body: string; project: string | null; updated: string; version: number; source: string;
  starred?: number; archived_at?: string | null;
}

function toNote(row: NoteRow): Note {
  return {
    slug: row.slug, title: row.title, body: row.body, project: row.project ?? undefined,
    updated: row.updated, version: row.version, source: row.source === "manual" ? "manual" : "chat",
    openCount: openQuestionCount(row.body),
    starred: row.starred === 1,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

const SELECT_NOTE = "SELECT slug, title, body, project, updated, version, source, starred, archived_at FROM notes";

/** Live notes; `includeArchived` adds archived ones (each carrying `archivedAt`). */
export async function loadNotes(file: string, opts: { includeArchived?: boolean } = {}): Promise<Note[]> {
  const db = openDb(file);
  const where = opts.includeArchived ? "" : " WHERE archived_at IS NULL";
  // Starred first, then newest. slug ASC as a tiebreaker: `updated` alone isn't unique (same-second saves), and without a
  // secondary key SQLite's tie order is unspecified — this keeps ties deterministic.
  const rows = db.prepare(`${SELECT_NOTE}${where} ORDER BY starred DESC, updated DESC, slug ASC`).all() as unknown as NoteRow[];
  return rows.map(toNote);
}

/** Prior versions of a note, oldest first — the notes_history counterpart to loadNotes. */
export async function loadNoteHistory(file: string, slug: string): Promise<Note[]> {
  const db = openDb(file);
  const rows = db.prepare(
    "SELECT slug, version, title, body, project, updated, source FROM notes_history WHERE slug = ? ORDER BY version",
  ).all(slug) as unknown as NoteRow[];
  return rows.map(toNote);
}

/** Create (no slug → a fresh UUID slug) or update-in-place (slug given). On update the prior row
 * is copied into notes_history first — updates are never destructive. An update to a missing or
 * archived slug throws, so a stale link can never write into another note. `upsert` (the routine
 * note sink only) instead creates a missing row, and updates an archived one without restoring it.
 * Returns the saved note's slug. */
export async function saveNote(
  file: string,
  draft: NoteDraft,
  now: () => Date = () => new Date(),
  opts: { upsert?: boolean } = {},
): Promise<string> {
  if (draft.slug !== undefined && traversal.test(draft.slug)) throw new Error(`invalid note slug: ${draft.slug}`);
  if (!draft.title.trim()) throw new Error("note title is required");
  const db = openDb(file);

  const slug = draft.slug || randomUUID();
  let version = 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (draft.slug) {
      const prev = db.prepare(`${SELECT_NOTE} WHERE slug = ?`).get(slug) as NoteRow | undefined;
      if (!opts.upsert && (!prev || prev.archived_at)) {
        throw new Error(`note ${slug} ${prev ? "is archived" : "does not exist"}`);
      }
      if (prev) {
        version = prev.version + 1;
        // A live note's own history is always below its version; rows at/above it are orphans of a
        // pre-UUID deleteNote whose title slug got reused — drop them so the snapshot can't collide.
        db.prepare("DELETE FROM notes_history WHERE slug = ? AND version >= ?").run(slug, prev.version);
        db.prepare(
          "INSERT INTO notes_history (slug, version, title, body, project, updated, source) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(prev.slug, prev.version, prev.title, prev.body, prev.project, prev.updated, prev.source);
      } else {
        // upsert creating v1: drop history orphaned by a pre-archive deleteNote so it can't collide.
        db.prepare("DELETE FROM notes_history WHERE slug = ?").run(slug);
      }
    }
    // The conflict update never touches archived_at or starred — those are lifecycle/view state, not edits.
    db.prepare(
      "INSERT INTO notes (slug, title, body, project, updated, version, source) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, project=excluded.project, " +
        "updated=excluded.updated, version=excluded.version, source=excluded.source",
    ).run(slug, draft.title.trim(), draft.body, draft.project ?? null, now().toISOString(), version, draft.source ?? "chat");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return slug;
}

/** Stars/unstars a note. Deliberately not part of saveNote: a star is a view preference, not
 * an edit, and shouldn't bump the version or push a row into notes_history. */
export async function starNote(file: string, slug: string, starred: boolean): Promise<void> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  openDb(file).prepare("UPDATE notes SET starred = ? WHERE slug = ?").run(starred ? 1 : 0, slug);
}

/** Archives a live note — hidden from loadNotes/searchNotes, version/history/star untouched.
 * Returns whether a row changed (false = missing or already archived). */
export async function archiveNote(file: string, slug: string, now: () => Date = () => new Date()): Promise<boolean> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  return Number(openDb(file).prepare("UPDATE notes SET archived_at = ? WHERE slug = ? AND archived_at IS NULL")
    .run(now().toISOString(), slug).changes) > 0;
}

/** Restores an archived note. Returns whether a row changed (false = missing or already live). */
export async function restoreNote(file: string, slug: string): Promise<boolean> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  return Number(openDb(file).prepare("UPDATE notes SET archived_at = NULL WHERE slug = ? AND archived_at IS NOT NULL")
    .run(slug).changes) > 0;
}

/** restoreNote for the chat-bot receipt, which must tell its three answers apart: "live" = already
 * restored, "missing" = purged (or never existed). Never creates a row. */
export async function restoreNoteOutcome(file: string, slug: string): Promise<"restored" | "live" | "missing"> {
  if (await restoreNote(file, slug)) return "restored";
  return openDb(file).prepare("SELECT 1 FROM notes WHERE slug = ?").get(slug) ? "live" : "missing";
}

/** Permanently deletes an archived note and all its history. Refuses a live (or missing) note —
 * archive first. Returns whether the note was purged. */
export async function purgeNote(file: string, slug: string): Promise<boolean> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT archived_at FROM notes WHERE slug = ?").get(slug) as { archived_at: string | null } | undefined;
    const purge = !!row?.archived_at;
    if (purge) {
      db.prepare("DELETE FROM notes_history WHERE slug = ?").run(slug);
      db.prepare("DELETE FROM notes WHERE slug = ?").run(slug);
    }
    db.exec("COMMIT");
    return purge;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** FTS5 search backing retrieve_note: an OR-of-prefix-words match over title+body, ranked by
 * bm25 — preserves the old word-match's "any shared word surfaces the note" contract (not a
 * whole-phrase match) while replacing its in-JS substring scoring. */
export async function searchNotes(file: string, query: string, limit = 5): Promise<Note[]> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const db = openDb(file);
  const matchQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" OR ");
  const rows = db.prepare(
    "SELECT n.slug, n.title, n.body, n.project, n.updated, n.version, n.source, n.starred FROM notes_fts f " +
      "JOIN notes n ON n.rowid = f.rowid WHERE notes_fts MATCH ? AND n.archived_at IS NULL ORDER BY bm25(notes_fts) LIMIT ?",
  ).all(matchQuery, limit) as unknown as NoteRow[];
  return rows.map(toNote);
}

/** ActionTool letting converse() look up a saved note by title/topic — notes are otherwise
 * write-only from chat (propose_note). */
export function retrieveNoteTool(searchNotesFn: (query: string) => Promise<Note[]>): ActionTool {
  return {
    spec: {
      name: "retrieve_note",
      description:
        "Search the user's saved notes by title or topic and return the best match's full content. " +
        "Use when the user asks you to look up, recall, retrieve, or read back a saved note.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "words from the note's title or topic to search for" } },
        required: ["query"],
      },
    },
    run: async (args) => {
      const { query } = (args ?? {}) as { query?: unknown };
      if (typeof query !== "string" || !query.trim()) return "error: retrieve_note needs { query }";
      const matches = await searchNotesFn(query);
      if (matches.length === 0) return `no saved notes matched "${query}"`;
      const note = matches[0]!;
      const others = matches.slice(1, 5).map((n) => n.title);
      return `# ${note.title}\n\n${note.body}` +
        (others.length > 0 ? `\n\n(other matches: ${others.join(", ")})` : "");
    },
  };
}
