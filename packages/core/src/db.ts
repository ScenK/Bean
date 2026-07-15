import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { isValidMemory } from "./memory/memory.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  text         TEXT NOT NULL,
  project_path TEXT,
  created_at   TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS notes (
  slug    TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  project TEXT,
  updated TEXT NOT NULL,
  version INTEGER NOT NULL,
  source  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes_history (
  slug    TEXT NOT NULL,
  version INTEGER NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  project TEXT,
  updated TEXT NOT NULL,
  source  TEXT NOT NULL,
  PRIMARY KEY (slug, version)
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS chatops_turns (
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS chatops_turns_conv ON chatops_turns(conversation_id);

CREATE TABLE IF NOT EXISTS todos (
  id             TEXT PRIMARY KEY,
  routine        TEXT NOT NULL,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  finished_at    TEXT,
  result_summary TEXT,
  ord            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_routine ON todos(routine);
`;

const cache = new Map<string, DatabaseSync>();

/** Opens (or returns the cached handle for) the bean.db at `file`, creating its schema on
 * first open. A brand-new file also triggers a one-time import of the legacy stores that used
 * to live alongside it (memory.json, notes/*.md, notes/.history/*.md) — afterward those files
 * are left on disk untouched but never read again. One `DatabaseSync` per path, cached here, so
 * callers (loadMemories/saveNote/etc.) never reopen the file per call. */
export function openDb(file: string): DatabaseSync {
  const cached = cache.get(file);
  if (cached) return cached;
  mkdirSync(dirname(file), { recursive: true });
  const isNew = !existsSync(file);
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  cache.set(file, db);
  if (isNew) migrateFromFiles(db, dirname(file));
  return db;
}

/** Releases the cached handle for `file` — call in test teardown before removing the temp
 * dir so the file descriptor doesn't linger for the rest of a long vitest run. */
export function closeDb(file: string): void {
  cache.get(file)?.close();
  cache.delete(file);
}

function migrateFromFiles(db: DatabaseSync, dir: string): void {
  migrateMemories(db, join(dir, "memory.json"));
  migrateNotes(db, join(dir, "notes"));
}

function migrateMemories(db: DatabaseSync, file: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO memories (id, text, project_path, created_at) VALUES (?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const m of parsed) {
      if (!isValidMemory(m)) continue;
      insert.run(m.id, m.text, m.projectPath ?? null, m.createdAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function migrateNotes(db: DatabaseSync, dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const insertNote = db.prepare(
    "INSERT OR IGNORE INTO notes (slug, title, body, project, updated, version, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertHistory = db.prepare(
    "INSERT OR IGNORE INTO notes_history (slug, version, title, body, project, updated, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const file of entries.filter((f) => f.endsWith(".md")).sort()) {
      const raw = readFileSync(join(dir, file), "utf8");
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const slug = basename(file, ".md");
      insertNote.run(
        slug, fm.title || slug, body, fm.project || null, fm.updated ?? "",
        Number(fm.version) >= 1 ? Number(fm.version) : 1, fm.source === "manual" ? "manual" : "chat",
      );
    }
    let historyEntries: string[] = [];
    try {
      historyEntries = readdirSync(join(dir, ".history"));
    } catch {
      // no history dir — nothing to import
    }
    for (const file of historyEntries.filter((f) => f.endsWith(".md"))) {
      const m = /^(.+)\.v(\d+)\.md$/.exec(file);
      if (!m) continue;
      const [, slug, versionStr] = m;
      const raw = readFileSync(join(dir, ".history", file), "utf8");
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
      insertHistory.run(
        slug!, Number(versionStr), fm.title || slug!, body, fm.project || null, fm.updated ?? "",
        fm.source === "manual" ? "manual" : "chat",
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
