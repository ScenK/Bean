import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { cjkBigrams, ftsMatchQuery } from "../fts-text.js";
import type { Embed } from "../openai-chat.js";
import { OWNER_PIN_LIMIT, asMemoryKind, isLive, sanitizeCategory, sanitizeContext, type Memory, type MemoryKind } from "./memory.js";

interface MemoryRow {
  id: string; text: string; project_path: string | null; created_at: string; subject_id?: string | null;
  category: string | null; source_id: string | null; source_title: string | null; context: string | null;
  expires_at?: string | null; evidence?: string | null; kind?: string | null;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id, text: row.text, projectPath: row.project_path ?? undefined, createdAt: row.created_at,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.source_title ? { sourceTitle: row.source_title } : {}),
    ...(row.context ? { context: row.context } : {}),
    ...(asMemoryKind(row.kind) ? { kind: asMemoryKind(row.kind) } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {}),
  };
}

// Declared async for call-site compatibility (every caller already awaits these) even though
// node:sqlite's DatabaseSync is synchronous under the hood — same convention as outbox.ts.
/** What a scoped read may see of rows captured from a channel (`source_id` set): `source` = that
 * one conversation's rows, `allSources` = every channel's (the owner's own surfaces). Neither =
 * none — what was said in one channel isn't recalled in another, or in a member's DM. */
export interface RecallScope { source?: string; allSources?: boolean; now?: number }

/** `subject` scopes recall, filtered in SQL before any ranking: absent = every row, expired ones
 * included (desktop and Persona, the owner's own machine — recall drops the expired in
 * `selectRelevantMemories`), `null` = household-shared only (channels, routines), an id =
 * shared plus that speaker's private rows (their DMs), a list = shared plus any of those ids (the
 * owner's DMs, via `ownerSubjectIds`; empty = shared only). A scoped read never returns an
 * expired row, and channel-captured rows only as `scope` allows. */
export async function loadMemories(file: string, subject?: string | string[] | null, scope: RecallScope = {}): Promise<Memory[]> {
  const db = openDb(file);
  const cols = "SELECT id, text, project_path, created_at, subject_id, category, source_id, source_title, context, expires_at, evidence, kind FROM memories";
  if (subject === undefined) return (db.prepare(`${cols} ORDER BY created_at`).all() as unknown as MemoryRow[]).map(toMemory);
  const ids = subject === null ? [] : typeof subject === "string" ? [subject] : [...new Set(subject)];
  const where = [
    ids.length === 0 ? "subject_id IS NULL" : `(subject_id IS NULL OR subject_id IN (${ids.map(() => "?").join(", ")}))`,
    "(expires_at IS NULL OR expires_at > ?)",
    ...(scope.allSources ? [] : [scope.source === undefined ? "source_id IS NULL" : "(source_id IS NULL OR source_id = ?)"]),
  ];
  const args = [...ids, new Date(scope.now ?? Date.now()).toISOString(), ...(!scope.allSources && scope.source !== undefined ? [scope.source] : [])];
  return (db.prepare(`${cols} WHERE ${where.join(" AND ")} ORDER BY created_at`).all(...args) as unknown as MemoryRow[]).map(toMemory);
}

/** Deletes rows that expired more than two weeks ago (the dream pass calls it). Returns the count.
 * ponytail: no undo and no history row — the memory said itself when it stopped mattering. */
export async function purgeExpiredMemories(file: string, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - 14 * 24 * 3_600_000).toISOString();
  return Number(openDb(file).prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?").run(cutoff).changes);
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
    "INSERT INTO memories (id, text, project_path, created_at, subject_id, category, source_id, source_title, context, expires_at, evidence, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const m of additions) {
      insert.run(
        m.id, m.text, m.projectPath ?? null, m.createdAt, m.subjectId ?? null,
        sanitizeCategory(m.category), m.sourceId ?? null, m.sourceTitle ?? null, sanitizeContext(m.context),
        m.expiresAt ?? null, m.evidence ?? null, asMemoryKind(m.kind) ?? null,
      );
    }
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

/** Per-row recategorize (null clears it). Never load+replace — a concurrent writer's row would be
 * lost (.memory/safety-memory-append-vs-replace.md). */
export async function updateMemoryCategory(file: string, id: string, category: string | null): Promise<void> {
  openDb(file).prepare("UPDATE memories SET category = ? WHERE id = ?").run(sanitizeCategory(category), id);
}

/** Renames a category in one UPDATE, so rows appended mid-rename under the old name still move or
 * keep it atomically. An empty `to` uncategorizes them. Returns rows changed. */
export async function renameMemoryCategory(file: string, from: string, to: string): Promise<number> {
  const old = sanitizeCategory(from);
  if (old === null) return 0;
  return Number(openDb(file).prepare("UPDATE memories SET category = ? WHERE category = ?").run(sanitizeCategory(to), old).changes);
}

/** Deletes exactly these ids; idempotent (already-gone ids are ignored). Returns the ids removed.
 * `subject` set = a non-owner speaker: only their own private rows go — never a shared row or
 * another member's (enforced here in SQL, not by the caller's id list). */
export async function deleteMemories(file: string, ids: string[], subject?: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const inList = `id IN (${ids.map(() => "?").join(",")})`;
  const db = openDb(file);
  const res = subject === undefined
    ? db.prepare(`DELETE FROM memories WHERE ${inList} RETURNING id`).all(...ids)
    : db.prepare(`DELETE FROM memories WHERE ${inList} AND subject_id = ? RETURNING id`).all(...ids, subject);
  return res.map((r) => String(r.id));
}

/** Makes the author's private row household-shared (the receipt card's Share button). Only the
 * row's own subject can share it — the owner gets no bypass — and text, project and date stay
 * as they are. Returns rows changed: 0 for anyone else's row, a shared row, or a gone one. */
export async function shareMemory(file: string, id: string, actor: string): Promise<number> {
  if (!actor) return 0;
  const res = openDb(file).prepare("UPDATE memories SET subject_id = NULL WHERE id = ? AND subject_id = ?").run(id, actor);
  return Number(res.changes);
}

// --- dream bookkeeping (memory/dream.ts) ---

/** One change a dream run makes: `ids` are replaced by one fact with `text` (a merge, or a
 * rewrite when there's a single id), or simply removed when `text` is absent (a drop). */
export interface DreamGroup {
  ids: string[]; text?: string; projectPath?: string;
  /** Carried onto the merged row: planDream only merges within one category and source, and
   * between equal or empty contexts (the one non-empty context is kept). */
  category?: string; sourceId?: string; sourceTitle?: string; context?: string; kind?: MemoryKind;
}
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

export async function getMemoryMeta(file: string, key: "lastDreamAt" | "lastDream" | "lastDigestAt"): Promise<unknown> {
  return readMeta(openDb(file), key);
}

/** Only the daily digest's watermark is written from outside this file (dream's keys stay inside
 * applyConsolidation's transaction). */
export async function setMemoryMeta(file: string, key: "lastDigestAt", value: string): Promise<void> {
  writeMeta(openDb(file), key, value);
}

/** Rows the owner may see that were saved in (`since`, `until`]: shared rows plus rows private to
 * one of `ownerIds` — never another member's private row. Filtered in SQL, oldest first. */
export async function memoriesSavedBetween(file: string, since: string, until: string, ownerIds: string[]): Promise<Memory[]> {
  const ids = [...new Set(ownerIds)];
  const mine = ids.length ? ` OR subject_id IN (${ids.map(() => "?").join(", ")})` : "";
  const rows = openDb(file).prepare(
    "SELECT id, text, project_path, created_at, subject_id, category, source_id, source_title, context, kind FROM memories " +
      `WHERE created_at > ? AND created_at <= ? AND (subject_id IS NULL${mine}) ORDER BY created_at`,
  ).all(since, until, ...ids) as unknown as MemoryRow[];
  return rows.map(toMemory);
}

export async function countMemoriesSince(file: string, iso: string): Promise<number> {
  // Shared rows only — dream never touches private ones (see dream.ts).
  const row = openDb(file).prepare("SELECT count(*) AS n FROM memories WHERE created_at > ? AND subject_id IS NULL").get(iso) as { n: number };
  return Number(row.n);
}

/** Atomic lease claim — one statement, so two processes (or two triggers in one) can't both win.
 * An expired lease (a crashed run) is taken over. No transaction is held across the model call. */
export async function claimDreamLease(file: string, runId: string, nowMs: number, ttlMs: number): Promise<boolean> {
  const res = openDb(file).prepare(
    `INSERT INTO memory_meta (key, value) VALUES ('dreamLease', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE json_extract(memory_meta.value, '$.expires') < ? OR json_extract(memory_meta.value, '$.runId') = ?`,
  ).run(JSON.stringify({ runId, expires: nowMs + ttlMs }), nowMs, runId);
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
      const get = db.prepare("SELECT text, project_path, category FROM memories WHERE id = ?");
      const byId = new Map(plan.expected.map((m) => [m.id, m]));
      for (const m of plan.expected) {
        const row = get.get(m.id) as Pick<MemoryRow, "text" | "project_path" | "category"> | undefined;
        // A recategorize mid-dream is the user's newer decision — don't merge it away.
        if (!row || row.text !== m.text || (row.project_path ?? undefined) !== m.projectPath ||
          (row.category ?? undefined) !== m.category) throw new Abort();
      }
      const at = plan.digest.at;
      const hist = db.prepare(
        "INSERT INTO memories_history (run_id, grp, phase, memory_id, text, project_path, created_at, at, category, source_id, source_title, context, kind) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const del = db.prepare("DELETE FROM memories WHERE id = ?");
      const ins = db.prepare(
        "INSERT INTO memories (id, text, project_path, created_at, category, source_id, source_title, context, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      plan.groups.forEach((g, grp) => {
        const before = g.ids.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
        for (const m of before) {
          hist.run(
            plan.runId, grp, "before", m.id, m.text, m.projectPath ?? null, m.createdAt, at,
            m.category ?? null, m.sourceId ?? null, m.sourceTitle ?? null, m.context ?? null, m.kind ?? null,
          );
          del.run(m.id);
        }
        if (g.text === undefined) return;
        // The group's newest date, not now: a merged fact isn't a "new memory" for the next
        // dream's ≥N-new trigger, and it keeps recall ordering stable.
        const createdAt = before.map((m) => m.createdAt).sort().at(-1) ?? at;
        const id = randomUUID();
        const extra = [g.category ?? null, g.sourceId ?? null, g.sourceTitle ?? null, sanitizeContext(g.context), g.kind ?? null] as const;
        ins.run(id, g.text, g.projectPath ?? null, createdAt, ...extra);
        hist.run(plan.runId, grp, "after", id, g.text, g.projectPath ?? null, createdAt, at, ...extra);
      });
      const cutoff = new Date(nowMs - HISTORY_KEEP_MS).toISOString();
      db.prepare("DELETE FROM memories_history WHERE at < ?").run(cutoff);
      // A digest whose history was just pruned can't be undone or detailed — stop offering it.
      const prev = readMeta(db, "lastDream") as DreamDigest | undefined;
      if (prev && prev.at < cutoff) db.prepare("DELETE FROM memory_meta WHERE key = 'lastDream'").run();
      writeMeta(db, "lastDreamAt", at);
      if (plan.groups.length > 0) writeMeta(db, "lastDream", plan.digest);
    });
    return true;
  } catch (err) {
    if (err instanceof Abort) return false;
    throw err;
  }
}

interface HistoryRow {
  grp: number; phase: "before" | "after"; memory_id: string; text: string; project_path: string | null; created_at: string;
  category: string | null; source_id: string | null; source_title: string | null; context: string | null;
  kind: string | null;
}
function historyGroups(db: DatabaseSync, runId: string): Map<number, HistoryRow[]> {
  const rows = db.prepare(
    "SELECT grp, phase, memory_id, text, project_path, created_at, category, source_id, source_title, context, kind " +
      "FROM memories_history WHERE run_id = ? ORDER BY grp, rowid",
  ).all(runId) as unknown as HistoryRow[];
  const groups = new Map<number, HistoryRow[]>();
  for (const r of rows) groups.set(r.grp, [...(groups.get(r.grp) ?? []), r]);
  return groups;
}

/** Undo a dream run: each group is restored only if its after-image (text, project, category) is
 * still exactly what's in memories — a row edited, recategorized or deleted since is the user's newer decision, so that group is kept
 * and counted in `skipped`. */
export async function restoreDreamRun(file: string, runId: string): Promise<{ restored: number; skipped: number }> {
  const db = openDb(file);
  return tx(db, () => {
    // Only the current last dream is undoable — checked inside the transaction, since a newer
    // dream could commit between the caller's read and this restore.
    const digest = readMeta(db, "lastDream") as DreamDigest | undefined;
    if (digest?.runId !== runId || digest.undone) return { restored: 0, skipped: 0 };
    const get = db.prepare("SELECT text, project_path, category FROM memories WHERE id = ?");
    const del = db.prepare("DELETE FROM memories WHERE id = ?");
    const ins = db.prepare(
      "INSERT OR IGNORE INTO memories (id, text, project_path, created_at, category, source_id, source_title, context, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let restored = 0;
    let skipped = 0;
    for (const rows of historyGroups(db, runId).values()) {
      const after = rows.filter((r) => r.phase === "after");
      const intact = after.every((r) => {
        const cur = get.get(r.memory_id) as { text: string; project_path: string | null; category: string | null } | undefined;
        return cur !== undefined && cur.text === r.text && cur.project_path === r.project_path && cur.category === r.category;
      });
      if (!intact) { skipped++; continue; }
      for (const r of after) del.run(r.memory_id);
      for (const r of rows.filter((x) => x.phase === "before")) {
        ins.run(r.memory_id, r.text, r.project_path, r.created_at, r.category, r.source_id, r.source_title, r.context, r.kind);
      }
      restored++;
    }
    writeMeta(db, "lastDream", { ...digest, undone: true });
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

export interface RecallOptions { skipThreshold?: number; pinCategory?: string; pinLimit?: number }

/** The one place recall's candidate rules live (selectRelevantMemories and meaningScores both use
 * it): drop expired rows, and at or below `skipThreshold` live rows leave `ranked` unset (inject
 * everything, no ranking). Above it, split off the newest `pinLimit` rows of `pinCategory` —
 * included first, never ranked — from the `pool` that is ranked. */
function recallCandidates(
  memories: Memory[], { skipThreshold = 40, pinCategory, pinLimit = OWNER_PIN_LIMIT }: RecallOptions, now = Date.now(),
): { live: Memory[]; ranked?: { pinned: Memory[]; pool: Memory[] } } {
  // Expired plans and deadlines never reach the model (the desktop read doesn't filter in SQL).
  const live = memories.filter((m) => isLive(m, now));
  if (live.length <= skipThreshold) return { live };
  // loadMemories orders by created_at, so the tail is the newest.
  const owned = pinCategory ? live.filter((m) => m.category === pinCategory) : [];
  const pinned = owned.slice(Math.max(0, owned.length - pinLimit));
  const pinnedIds = new Set(pinned.map((m) => m.id));
  return { live, ranked: { pinned, pool: live.filter((m) => !pinnedIds.has(m.id)) } };
}

/** Pure top-K relevance ranking for memoriesBlock(): small memory sets are still injected
 * wholesale (today's behavior); above `skipThreshold` an FTS5 bm25 rank against `latestUserText`
 * picks the top `limit`, always force-including memories scoped to `currentProjectPath`.
 * `pinCategory` (owner paths only, #650): the newest `pinLimit` rows in exactly that category are
 * included first and kept out of the ranked pool, so they don't count against `limit`.
 * `scores` (meaningScores' cosine per id): fused with the bm25 rank by reciprocal-rank fusion, so
 * a same-meaning row with no shared word can still make the cut. */
export function selectRelevantMemories(
  memories: Memory[],
  latestUserText: string,
  currentProjectPath?: string,
  { limit = 30, scores, ...opts }: RecallOptions & { limit?: number; scores?: Map<string, number> } = {},
): Memory[] {
  const { live, ranked } = recallCandidates(memories, opts);
  if (!ranked) return live;
  return [...ranked.pinned, ...rankRelevant(ranked.pool, latestUserText, currentProjectPath, limit, scores)];
}

function rankRelevant(
  memories: Memory[], latestUserText: string, currentProjectPath: string | undefined, limit: number, scores?: Map<string, number>,
): Memory[] {
  const forced = currentProjectPath
    ? memories.filter((m) => m.projectPath === currentProjectPath)
    : [];
  const forcedIds = new Set(forced.map((m) => m.id));
  const rest = memories.filter((m) => !forcedIds.has(m.id));
  const remaining = Math.max(0, limit - forced.length);
  if (remaining === 0 || rest.length === 0) return forced;

  const matchQuery = ftsMatchQuery(latestUserText);
  if (!matchQuery && !scores) return [...forced, ...rest.slice(0, remaining)];

  let ids: string[] = [];
  if (matchQuery) {
    // ponytail: a throwaway :memory: db per call — sub-millisecond at this scale (verified
    // locally), simpler than threading a second persistent handle through converse()'s DI chain.
    const scratch = new DatabaseSync(":memory:");
    scratch.exec("CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, text)");
    const insert = scratch.prepare("INSERT INTO t (id, text) VALUES (?, ?)");
    // The context label is searchable too: "that tool someone mentioned" can match a fact whose
    // referent lives only in its label.
    for (const m of rest) insert.run(m.id, cjkBigrams(m.context ? `${m.text} ${m.context}` : m.text));
    const ranked = scratch.prepare(
      "SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT ?",
    ).all(matchQuery, remaining) as unknown as { id: string }[];
    scratch.close();
    ids = ranked.map((r) => r.id);
  }
  // Each ranking nominates its own top `remaining`, then RRF merges them: fusing the full lists
  // would let every weak keyword hit that is also mid-pack by meaning outrank a row that is first
  // by meaning but shares no word — the very row this exists to find.
  if (scores) {
    const byMeaning = rest.filter((m) => scores.has(m.id)).sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
    ids = fuseRanks(ids, byMeaning.slice(0, remaining).map((m) => m.id)).slice(0, remaining);
  }
  const byId = new Map(rest.map((m) => [m.id, m]));
  const top = ids.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
  // Backfill with the most recent remaining memories if FTS matched fewer than `remaining`.
  if (top.length < remaining) {
    const topIds = new Set(top.map((m) => m.id));
    const backfill = rest.filter((m) => !topIds.has(m.id)).slice(-(remaining - top.length));
    return [...forced, ...top, ...backfill];
  }
  return [...forced, ...top];
}

/** Reciprocal-rank fusion (k = 60) of two best-first id lists; an id in only one list gets only
 * that list's term. Best first; ties keep bm25's order. */
function fuseRanks(bm25: string[], meaning: string[]): string[] {
  const fused = new Map<string, number>();
  for (const list of [bm25, meaning]) list.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...fused.keys()].sort((a, b) => fused.get(b)! - fused.get(a)!);
}
const RRF_K = 60;

// --- meaning scores (cached embeddings) ---

/** text-embedding-3-small's width; the one encoding `memory_vectors.vec` holds. */
const EMBED_DIMS = 1536;
const EMBED_BATCH = 256;
const EMBED_INPUT_CHARS = 2000;
const EMBED_WAIT_MS = 3000;

const embedInput = (m: Memory): string => (m.context ? `${m.text}\n${m.context}` : m.text).slice(0, EMBED_INPUT_CHARS);
const vectorHash = (model: string, m: Memory): string =>
  createHash("sha256").update(`${model}\0${m.text}\0${m.context ?? ""}`).digest("hex");

function norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}
/** A vector we can use: the fixed width, every value finite, not all zero. */
const usable = (v: Float32Array | undefined): v is Float32Array =>
  v !== undefined && v.length === EMBED_DIMS && v.every(Number.isFinite) && norm(v) > 0;

function encodeVec(v: Float32Array): Uint8Array {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf;
}
function decodeVec(blob: Uint8Array): Float32Array | undefined {
  if (blob.byteLength !== EMBED_DIMS * 4) return undefined;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  return Float32Array.from({ length: EMBED_DIMS }, (_, i) => buf.readFloatLE(i * 4));
}
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (norm(a) * norm(b));
}

/** Cosine similarity of `query` to each ranked candidate (recallCandidates' pool — pinned and
 * expired rows are never sent), for selectRelevantMemories' `scores`. Vectors are cached in
 * `memory_vectors`; one embed call carries the query plus up to 256 missing or stale rows (newest
 * first), and rows left over rank by bm25 alone this time. `undefined` = rank as today: too few
 * candidates (no call made), a throw, a malformed vector, abort, or no answer within `waitMs` — in
 * the last two the request still finishes in the background and caches its vectors. */
export async function meaningScores(
  file: string, embed: Embed, memories: Memory[], query: string,
  { signal, waitMs = EMBED_WAIT_MS, ...opts }: RecallOptions & { signal?: AbortSignal; waitMs?: number } = {},
): Promise<Map<string, number> | undefined> {
  const pool = recallCandidates(memories, opts).ranked?.pool ?? [];
  if (pool.length <= (opts.skipThreshold ?? 40) || !query.trim() || signal?.aborted) return undefined;

  const get = openDb(file).prepare("SELECT hash, vec FROM memory_vectors WHERE id = ?");
  const vectors = new Map<string, Float32Array>();
  const missing: Memory[] = [];
  for (const m of pool) {
    const row = get.get(m.id) as { hash: string; vec: Uint8Array } | undefined;
    const vec = row?.hash === vectorHash(embed.model, m) ? decodeVec(row.vec) : undefined;
    if (usable(vec)) vectors.set(m.id, vec);
    else missing.push(m);
  }
  const batch = missing.slice(-EMBED_BATCH);

  const work = (async (): Promise<Float32Array> => {
    const out = await embed([query.slice(-EMBED_INPUT_CHARS), ...batch.map(embedInput)]);
    if (out.length !== batch.length + 1 || !out.every(usable)) throw new TypeError("malformed embedding");
    // Re-opened, not the handle above: this may land after the caller has stopped waiting. A row
    // deleted mid-call gets no vector.
    const put = openDb(file).prepare(
      "INSERT OR REPLACE INTO memory_vectors (id, hash, vec) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)",
    );
    batch.forEach((m, i) => {
      const vec = out[i + 1]!;
      put.run(m.id, vectorHash(embed.model, m), encodeVec(vec), m.id);
      vectors.set(m.id, vec);
    });
    return out[0]!;
  })().catch((err: unknown) => {
    console.warn(`[memory] meaning scores failed (${err instanceof Error ? err.name : typeof err}), ${batch.length} rows`);
    return undefined;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const gaveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, waitMs, undefined);
    onAbort = () => resolve(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const queryVec = await Promise.race([work, gaveUp]);
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (!queryVec) return undefined;
  return new Map([...vectors].map(([id, v]) => [id, cosine(queryVec, v)]));
}

/** meaningScores bound to one bean.db and embedder — the optional recall dependency of
 * converse(), routine steps and chime-ins. Pass the same `memories` (already scope-filtered by
 * the caller's loadMemories) and recall options the selection uses, so the embedder only ever
 * sees rows that turn could recall. */
export type RankByMeaning = (
  memories: Memory[], query: string, opts?: RecallOptions & { signal?: AbortSignal },
) => Promise<Map<string, number> | undefined>;

export function makeRankByMeaning(file: string, embed: Embed): RankByMeaning {
  return (memories, query, opts) => meaningScores(file, embed, memories, query, opts);
}
