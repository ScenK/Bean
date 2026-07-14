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
}

export interface NoteDraft {
  title: string;
  body: string;
  project?: string;
  source?: "chat" | "manual";
  /** Present = update that note in place (version bump, prior version kept in notes_history). */
  slug?: string;
}

export function openQuestionCount(body: string): number {
  return (body.match(/^\s*[-*] \[ \]/gm) ?? []).length;
}

function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "note";
}

const traversal = /[/\\]|\.\./;

interface NoteRow {
  slug: string; title: string; body: string; project: string | null; updated: string; version: number; source: string;
}

function toNote(row: NoteRow): Note {
  return {
    slug: row.slug, title: row.title, body: row.body, project: row.project ?? undefined,
    updated: row.updated, version: row.version, source: row.source === "manual" ? "manual" : "chat",
    openCount: openQuestionCount(row.body),
  };
}

const SELECT_NOTE = "SELECT slug, title, body, project, updated, version, source FROM notes";

export async function loadNotes(file: string): Promise<Note[]> {
  const db = openDb(file);
  // slug ASC as a tiebreaker: `updated` alone isn't unique (same-second saves), and without a
  // secondary key SQLite's tie order is unspecified — this keeps ties deterministic.
  const rows = db.prepare(`${SELECT_NOTE} ORDER BY updated DESC, slug ASC`).all() as unknown as NoteRow[];
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

/** Create (no slug) or update-in-place (slug given). On update the prior row is copied into
 * notes_history first — updates are never destructive. Returns the saved note's slug. */
export async function saveNote(
  file: string,
  draft: NoteDraft,
  now: () => Date = () => new Date(),
): Promise<string> {
  if (draft.slug !== undefined && traversal.test(draft.slug)) throw new Error(`invalid note slug: ${draft.slug}`);
  if (!draft.title.trim()) throw new Error("note title is required");
  const db = openDb(file);

  let slug = draft.slug;
  let version = 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (slug) {
      const prev = db.prepare(`${SELECT_NOTE} WHERE slug = ?`).get(slug) as NoteRow | undefined;
      if (prev) {
        version = prev.version + 1;
        db.prepare(
          "INSERT OR IGNORE INTO notes_history (slug, version, title, body, project, updated, source) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(prev.slug, prev.version, prev.title, prev.body, prev.project, prev.updated, prev.source);
      }
      // slug given but no row (deleted or never existed) — treat as a fresh v1 create under that slug
    } else {
      slug = slugify(draft.title);
      const taken = new Set(
        (db.prepare("SELECT slug FROM notes").all() as unknown as { slug: string }[]).map((r) => r.slug),
      );
      for (let i = 2; taken.has(slug); i++) slug = `${slugify(draft.title)}-${i}`;
    }
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

/** Removes the note row; notes_history versions are deliberately kept. */
export async function deleteNote(file: string, slug: string): Promise<void> {
  if (traversal.test(slug)) throw new Error(`invalid note slug: ${slug}`);
  const db = openDb(file);
  db.prepare("DELETE FROM notes WHERE slug = ?").run(slug);
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
    "SELECT n.slug, n.title, n.body, n.project, n.updated, n.version, n.source FROM notes_fts f " +
      "JOIN notes n ON n.rowid = f.rowid WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?",
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
