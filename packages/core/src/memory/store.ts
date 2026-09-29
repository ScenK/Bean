import { randomUUID } from "node:crypto";
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

// --- dream bookkeeping (memory/dream.ts) ---

/** One change a dream run makes: `ids` are replaced by one fact with `text` (a merge, or a
 * rewrite when there's a single id), or simply removed when `text` is absent (a drop). */
export interface DreamGroup { ids: string[]; text?: string; projectPath?: string }
export interface DreamDigest { runId: string; at: string; merged: number; rewritten: number; removed: number; undone?: boolean }
export interface DreamPlan {
  runId: string;
  groups: DreamGroup[];
  /** The rows the plan was computed from — apply aborts if any has changed or gone since. */
  expected: Memory[];
  digest: DreamDigest;
}

const HISTORY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function readMeta(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return undefined; }
}
function writeMeta(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export async function getMemoryMeta(file: string, key: "lastDreamAt" | "lastDream"): Promise<unknown> {
  return readMeta(openDb(file), key);
}

export async function countMemoriesSince(file: string, iso: string): Promise<number> {
  const row = openDb(file).prepare("SELECT count(*) AS n FROM memories WHERE created_at > ?").get(iso) as { n: number };
  return Number(row.n);
}

/** Atomic lease claim — one statement, so two processes (or two triggers in one) can't both win.
 * An expired lease (a crashed run) is taken over. No transaction is held across the model call. */
export async function claimDreamLease(file: string, runId: string, nowMs: number, ttlMs: number): Promise<boolean> {
  const res = openDb(file).prepare(
    `INSERT INTO memory_meta (key, value) VALUES ('dreamLease', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE json_extract(memory_meta.value, '$.expires') < ?`,
  ).run(JSON.stringify({ runId, expires: nowMs + ttlMs }), nowMs);
  return Number(res.changes) > 0;
}

export async function releaseDreamLease(file: string, runId: string): Promise<void> {
  openDb(file).prepare("DELETE FROM memory_meta WHERE key = 'dreamLease' AND json_extract(value, '$.runId') = ?").run(runId);
}

function tx<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = body();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
class Abort extends Error {}

/** Applies a dream plan in one BEGIN IMMEDIATE: verifies the lease is still ours and every
 * touched row is unchanged since the plan was read, snapshots before/after images into
 * memories_history, makes only the targeted deletes/inserts, and records lastDreamAt + the
 * digest. Any mismatch aborts the whole run with no partial mutation; rows appended mid-dream
 * are never touched. Returns false when aborted. */
export async function applyConsolidation(file: string, plan: DreamPlan, nowMs: number): Promise<boolean> {
  const db = openDb(file);
  try {
    tx(db, () => {
      const lease = readMeta(db, "dreamLease") as { runId?: string; expires?: number } | undefined;
      if (lease?.runId !== plan.runId || (lease.expires ?? 0) < nowMs) throw new Abort();
      const get = db.prepare("SELECT id, text, project_path, created_at FROM memories WHERE id = ?");
      const byId = new Map(plan.expected.map((m) => [m.id, m]));
      for (const m of plan.expected) {
        const row = get.get(m.id) as MemoryRow | undefined;
        if (!row || row.text !== m.text || (row.project_path ?? undefined) !== m.projectPath) throw new Abort();
      }
      const at = plan.digest.at;
      const hist = db.prepare(
        "INSERT INTO memories_history (run_id, grp, phase, memory_id, text, project_path, created_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const del = db.prepare("DELETE FROM memories WHERE id = ?");
      const ins = db.prepare("INSERT INTO memories (id, text, project_path, created_at) VALUES (?, ?, ?, ?)");
      plan.groups.forEach((g, grp) => {
        const before = g.ids.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
        for (const m of before) {
          hist.run(plan.runId, grp, "before", m.id, m.text, m.projectPath ?? null, m.createdAt, at);
          del.run(m.id);
        }
        if (g.text === undefined) return;
        // The group's newest date, not now: a merged fact isn't a "new memory" for the next
        // dream's ≥N-new trigger, and it keeps recall ordering stable.
        const createdAt = before.map((m) => m.createdAt).sort().at(-1) ?? at;
        const id = randomUUID();
        ins.run(id, g.text, g.projectPath ?? null, createdAt);
        hist.run(plan.runId, grp, "after", id, g.text, g.projectPath ?? null, createdAt, at);
      });
      db.prepare("DELETE FROM memories_history WHERE at < ?").run(new Date(nowMs - HISTORY_KEEP_MS).toISOString());
      writeMeta(db, "lastDreamAt", at);
      if (plan.groups.length > 0) writeMeta(db, "lastDream", plan.digest);
    });
    return true;
  } catch (err) {
    if (err instanceof Abort) return false;
    throw err;
  }
}

interface HistoryRow { grp: number; phase: "before" | "after"; memory_id: string; text: string; project_path: string | null; created_at: string }
function historyGroups(db: DatabaseSync, runId: string): Map<number, HistoryRow[]> {
  const rows = db.prepare(
    "SELECT grp, phase, memory_id, text, project_path, created_at FROM memories_history WHERE run_id = ? ORDER BY grp, rowid",
  ).all(runId) as unknown as HistoryRow[];
  const groups = new Map<number, HistoryRow[]>();
  for (const r of rows) groups.set(r.grp, [...(groups.get(r.grp) ?? []), r]);
  return groups;
}

/** Undo a dream run: each group is restored only if its after-image is still exactly what's in
 * memories — a row edited or deleted since is the user's newer decision, so that group is kept
 * and counted in `skipped`. */
export async function restoreDreamRun(file: string, runId: string): Promise<{ restored: number; skipped: number }> {
  const db = openDb(file);
  return tx(db, () => {
    const digest = readMeta(db, "lastDream") as DreamDigest | undefined;
    if (digest?.runId === runId && digest.undone) return { restored: 0, skipped: 0 }; // already undone
    const get = db.prepare("SELECT text, project_path FROM memories WHERE id = ?");
    const del = db.prepare("DELETE FROM memories WHERE id = ?");
    const ins = db.prepare("INSERT OR IGNORE INTO memories (id, text, project_path, created_at) VALUES (?, ?, ?, ?)");
    let restored = 0;
    let skipped = 0;
    for (const rows of historyGroups(db, runId).values()) {
      const after = rows.filter((r) => r.phase === "after");
      const intact = after.every((r) => {
        const cur = get.get(r.memory_id) as { text: string; project_path: string | null } | undefined;
        return cur !== undefined && cur.text === r.text && cur.project_path === r.project_path;
      });
      if (!intact) { skipped++; continue; }
      for (const r of after) del.run(r.memory_id);
      for (const r of rows.filter((x) => x.phase === "before")) ins.run(r.memory_id, r.text, r.project_path, r.created_at);
      restored++;
    }
    if (digest?.runId === runId) writeMeta(db, "lastDream", { ...digest, undone: true });
    return { restored, skipped };
  });
}

/** Persona's "Details ▸": each group's before → after texts (after absent = removed). */
export async function dreamDetails(file: string, runId: string): Promise<{ before: string[]; after?: string }[]> {
  return [...historyGroups(openDb(file), runId).values()].map((rows) => ({
    before: rows.filter((r) => r.phase === "before").map((r) => r.text),
    after: rows.find((r) => r.phase === "after")?.text,
  }));
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
