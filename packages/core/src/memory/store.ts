import { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type { Memory } from "./memory.js";

interface MemoryRow { id: string; text: string; project_path: string | null; created_at: string }

function toMemory(row: MemoryRow): Memory {
  return { id: row.id, text: row.text, projectPath: row.project_path ?? undefined, createdAt: row.created_at };
}

// Declared async for call-site compatibility (every caller already awaits these) even though
// node:sqlite's DatabaseSync is synchronous under the hood — same convention as outbox.ts.
export async function loadMemories(file: string): Promise<Memory[]> {
  const db = openDb(file);
  const rows = db.prepare("SELECT id, text, project_path, created_at FROM memories ORDER BY created_at").all() as unknown as MemoryRow[];
  return rows.map(toMemory);
}

// Insert-only, no read step. A load → mutate in JS → replace-whole-list round trip is exactly the
// multi-process lost-update race this migration exists to fix (why saveMemories was deleted): two
// concurrent load-then-replace round trips can each read the same snapshot and one clobbers the
// other's addition, no matter how the underlying storage is locked — SQLite's transaction
// guarantees only cover a single statement/transaction, not two separate JS-level calls. Every
// path adding new facts (auto-remember at chat close, the remember tool) must use this, and every
// edit/delete goes through the per-row updateMemory/deleteMemories below — never
// load+mutate+replace. See .memory/safety-memory-append-vs-replace.md.
export async function appendMemories(file: string, additions: Memory[]): Promise<void> {
  const db = openDb(file);
  const insert = db.prepare(
    "INSERT INTO memories (id, text, project_path, created_at) VALUES (?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const m of additions) insert.run(m.id, m.text, m.projectPath ?? null, m.createdAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Per-row edit: touches one row, so a concurrent append (auto-remember finishing while the
// Persona panel is open) can't be lost the way a whole-list replace would lose it.
export async function updateMemory(file: string, id: string, text: string): Promise<void> {
  openDb(file).prepare("UPDATE memories SET text = ? WHERE id = ?").run(text, id);
}

/** Deletes exactly these ids; idempotent (already-gone ids are ignored). Returns rows removed. */
export async function deleteMemories(file: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = openDb(file).prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  return Number(res.changes);
}

/** Pure top-K relevance ranking for memoriesBlock(): small memory sets are still injected
 * wholesale (today's behavior); above `skipThreshold` an FTS5 bm25 rank against `latestUserText`
 * picks the top `limit`, always force-including memories scoped to `currentProjectPath`. */
export function selectRelevantMemories(
  memories: Memory[],
  latestUserText: string,
  currentProjectPath?: string,
  limit = 12,
  skipThreshold = 20,
): Memory[] {
  if (memories.length <= skipThreshold) return memories;

  const forced = currentProjectPath
    ? memories.filter((m) => m.projectPath === currentProjectPath)
    : [];
  const forcedIds = new Set(forced.map((m) => m.id));
  const rest = memories.filter((m) => !forcedIds.has(m.id));
  const remaining = Math.max(0, limit - forced.length);
  if (remaining === 0 || rest.length === 0) return forced;

  const words = latestUserText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...forced, ...rest.slice(0, remaining)];

  // ponytail: a throwaway :memory: db per call — sub-millisecond at this scale (verified
  // locally), simpler than threading a second persistent handle through converse()'s DI chain.
  const scratch = new DatabaseSync(":memory:");
  scratch.exec("CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, text)");
  const insert = scratch.prepare("INSERT INTO t (id, text) VALUES (?, ?)");
  for (const m of rest) insert.run(m.id, m.text);
  const matchQuery = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" OR ");
  const ranked = scratch.prepare(
    "SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT ?",
  ).all(matchQuery, remaining) as unknown as { id: string }[];
  scratch.close();
  const byId = new Map(rest.map((m) => [m.id, m]));
  const top = ranked.map((r) => byId.get(r.id)).filter((m): m is Memory => m !== undefined);
  // Backfill with the most recent remaining memories if FTS matched fewer than `remaining`.
  if (top.length < remaining) {
    const topIds = new Set(top.map((m) => m.id));
    const backfill = rest.filter((m) => !topIds.has(m.id)).slice(-(remaining - top.length));
    return [...forced, ...top, ...backfill];
  }
  return [...forced, ...top];
}
