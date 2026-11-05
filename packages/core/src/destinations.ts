import { openDb } from "./db.js";
import type { ChatopsSurface } from "./chatops/catalog.js";

export type DestinationKind = "channel" | "thread" | "group" | "meeting" | "dm";

/** Identifies one `chat_destinations` row. */
export interface DestinationKey {
  surface: ChatopsSurface;
  /** Discord channel/thread id; Teams conversation id (channels keyed by their bare channel id). */
  conversationId: string;
}

/** What a bot saw: platform names are untrusted display data, absent = unknown (never "cleared"). */
export interface SeenDestination extends DestinationKey {
  kind: DestinationKind;
  platformName?: string;
  /** Discord guild / Teams team. */
  parentName?: string;
}

export interface Destination extends SeenDestination {
  /** The owner's name for it; unique across every row. */
  alias?: string;
  lastSeen: string;
}

/** The sprouts (or other users) referencing `alias`; empty = free to rename or clear. */
export type AliasInUse = (alias: string) => readonly string[];

export type AliasResult = { ok: true } | { ok: false; error: string };

const THROTTLE_MS = 60 * 60 * 1000;

const clean = (s: string | undefined): string | null => s?.replace(/\s+/g, " ").trim().slice(0, 100) || null;

/** Upserts a seen conversation: names/kind/last_seen, never `alias`. A known name is kept when
 * this sighting has none. Skipped when nothing changed and last_seen is under an hour old.
 * Returns whether a row was written; never throws (discovery must not fail a delivery). */
export function recordDestination(file: string, seen: SeenDestination, now: () => Date = () => new Date()): boolean {
  const at = now();
  try {
    const { changes } = openDb(file).prepare(
      `INSERT INTO chat_destinations (surface, conversation_id, kind, platform_name, parent_name, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (surface, conversation_id) DO UPDATE SET
         kind = excluded.kind,
         platform_name = COALESCE(excluded.platform_name, platform_name),
         parent_name = COALESCE(excluded.parent_name, parent_name),
         last_seen = excluded.last_seen
       WHERE kind IS NOT excluded.kind
          OR (excluded.platform_name IS NOT NULL AND excluded.platform_name IS NOT platform_name)
          OR (excluded.parent_name IS NOT NULL AND excluded.parent_name IS NOT parent_name)
          OR last_seen < ?`,
    ).run(
      seen.surface, seen.conversationId, seen.kind, clean(seen.platformName), clean(seen.parentName),
      at.toISOString(), new Date(at.getTime() - THROTTLE_MS).toISOString(),
    );
    return Number(changes) > 0;
  } catch (err) {
    console.warn(`bean: couldn't record a ${seen.surface} destination:`, err instanceof Error ? err.name : "error");
    return false;
  }
}

interface DbRow {
  surface: ChatopsSurface;
  conversation_id: string;
  kind: DestinationKind;
  platform_name: string | null;
  parent_name: string | null;
  alias: string | null;
  last_seen: string;
}

/** Every seen conversation (optionally one surface's), most recently seen first. */
export function listDestinations(file: string, surface?: ChatopsSurface): Destination[] {
  const sql = "SELECT * FROM chat_destinations" + (surface ? " WHERE surface = ?" : "") + " ORDER BY last_seen DESC, conversation_id";
  const rows = openDb(file).prepare(sql).all(...(surface ? [surface] : [])) as unknown as DbRow[];
  return rows.map((r) => ({
    surface: r.surface, conversationId: r.conversation_id, kind: r.kind, lastSeen: r.last_seen,
    ...(r.platform_name ? { platformName: r.platform_name } : {}),
    ...(r.parent_name ? { parentName: r.parent_name } : {}),
    ...(r.alias ? { alias: r.alias } : {}),
  }));
}

/** Case, punctuation and whitespace folded away: "#The Ops-Channel" → "the ops channel". */
export function normalizeName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const sameRow = (a: DestinationKey, b: DestinationKey): boolean =>
  a.surface === b.surface && a.conversationId === b.conversationId;
const baseName = (r: Destination): string | undefined => r.alias ?? r.platformName;
const shortId = (id: string): string => (id.split("@")[0] ?? id).replace(/[^A-Za-z0-9]/g, "").slice(-4);

/** The row's display/match label: alias, else platform name. A platform name another row shares
 * (normalized) gets its parent name, then — if that still collides — a short id appended. An alias
 * is unique by construction and stays bare. No alias and no name = no label (not offered). */
export function destinationLabel(row: Destination, rows: readonly Destination[]): string | undefined {
  const name = baseName(row);
  if (!name) return undefined;
  if (row.alias) return row.alias;
  const key = normalizeName(name);
  const clashes = rows.filter((r) => !sameRow(r, row) && normalizeName(baseName(r) ?? "") === key);
  if (!clashes.length) return name;
  const parent = row.parentName;
  if (parent && !clashes.some((r) => !r.alias && normalizeName(r.parentName ?? "") === normalizeName(parent))) {
    return `${name} (${parent})`;
  }
  return `${name} (${parent ? `${parent}, ` : ""}${shortId(row.conversationId)})`;
}

function inTransaction(file: string, fn: () => AliasResult): AliasResult {
  const db = openDb(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const findRow = (file: string, key: DestinationKey): Destination | undefined =>
  listDestinations(file, key.surface).find((r) => r.conversationId === key.conversationId);

const usedBy = (alias: string, inUse: AliasInUse): AliasResult | undefined => {
  const users = inUse(alias);
  return users.length ? { ok: false, error: `"${alias}" is used by ${users.join(", ")} — retarget it instead.` } : undefined;
};

const writeAlias = (file: string, key: DestinationKey, alias: string | null): void => {
  openDb(file).prepare("UPDATE chat_destinations SET alias = ? WHERE surface = ? AND conversation_id = ?")
    .run(alias, key.surface, key.conversationId);
};

/** Names (or renames) a row. Refused when the row's current alias is referenced, or when the new
 * alias collides (normalized) with another row's alias, platform name or label. */
export function setAlias(file: string, key: DestinationKey, alias: string, inUse: AliasInUse): AliasResult {
  const name = alias.replace(/\s+/g, " ").trim();
  if (!normalizeName(name)) return { ok: false, error: "A name needs at least one letter or number." };
  if (name.length > 64) return { ok: false, error: "Keep the name under 64 characters." };
  return inTransaction(file, () => {
    const all = listDestinations(file);
    const row = all.find((r) => sameRow(r, key));
    if (!row) return { ok: false, error: "That conversation isn't known." };
    if (row.alias === name) return { ok: true };
    if (row.alias) {
      const refused = usedBy(row.alias, inUse);
      if (refused) return refused;
    }
    const key2 = normalizeName(name);
    const taken = all.some((r) => !sameRow(r, row) &&
      [r.alias, r.platformName, destinationLabel(r, all)].some((n) => n !== undefined && normalizeName(n) === key2));
    if (taken) return { ok: false, error: `"${name}" is already another conversation's name.` };
    writeAlias(file, key, name);
    return { ok: true };
  });
}

/** Removes a row's alias; refused while it is referenced. */
export function clearAlias(file: string, key: DestinationKey, inUse: AliasInUse): AliasResult {
  return inTransaction(file, () => {
    const row = findRow(file, key);
    if (!row) return { ok: false, error: "That conversation isn't known." };
    if (!row.alias) return { ok: true };
    const refused = usedBy(row.alias, inUse);
    if (refused) return refused;
    writeAlias(file, key, null);
    return { ok: true };
  });
}

/** Moves `alias` to another row of the same surface (how a referenced alias changes target). The
 * target's own alias is replaced, so it must not be referenced. */
export function retargetAlias(file: string, alias: string, to: DestinationKey, inUse: AliasInUse): AliasResult {
  return inTransaction(file, () => {
    const from = listDestinations(file).find((r) => r.alias === alias);
    if (!from) return { ok: false, error: `No conversation is named "${alias}".` };
    if (sameRow(from, to)) return { ok: true };
    if (from.surface !== to.surface) return { ok: false, error: "A name can only move to a conversation on the same platform." };
    const target = findRow(file, to);
    if (!target) return { ok: false, error: "That conversation isn't known." };
    if (target.alias) {
      const refused = usedBy(target.alias, inUse);
      if (refused) return refused;
    }
    writeAlias(file, from, null);
    writeAlias(file, to, alias);
    return { ok: true };
  });
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Each query token's best similarity against the name's tokens, weighted by token length. */
function fuzzyScore(query: string, name: string): number {
  const qt = query.split(" ");
  const nt = name.split(" ");
  let total = 0;
  let weight = 0;
  for (const q of qt) {
    const best = Math.max(...nt.map((n) => 1 - editDistance(q, n) / Math.max(q.length, n.length)));
    total += best * q.length;
    weight += q.length;
  }
  return weight ? total / weight : 0;
}

const FUZZY_PICK = 0.75;
const FUZZY_MARGIN = 0.05;
const FUZZY_FLOOR = 0.5;

export interface DestinationMatch {
  /** Set only for a confident, unique match. */
  pick?: Destination;
  /** The rows that matched at the deciding stage, best first; empty = nothing close. */
  candidates: Destination[];
}

/** Resolves a spoken name against `rows` (the caller's scope — nothing outside it is returned).
 * Stages, first that matches wins: exact → normalized → all query tokens present → substring →
 * edit distance. A stage matching several rows, or a fuzzy match below the threshold or within
 * the margin of the runner-up, returns no pick. Unlabelled rows are never matched. */
export function matchDestination(query: string, rows: readonly Destination[]): DestinationMatch {
  const q = normalizeName(query);
  if (!q) return { candidates: [] };
  const named = rows.flatMap((row) => {
    const names = [destinationLabel(row, rows), row.alias, row.platformName].filter((n): n is string => !!n);
    return names.length ? [{ row, names, norms: names.map(normalizeName) }] : [];
  });
  const qTokens = q.split(" ");
  const stages: ((e: (typeof named)[number]) => boolean)[] = [
    (e) => e.names.includes(query.trim()),
    (e) => e.norms.includes(q),
    (e) => e.norms.some((n) => { const t = n.split(" "); return qTokens.every((x) => t.includes(x)); }),
    (e) => e.norms.some((n) => n.includes(q)),
  ];
  for (const stage of stages) {
    const hits = named.filter(stage).map((e) => e.row);
    if (hits.length) return hits.length === 1 ? { pick: hits[0], candidates: hits } : { candidates: hits };
  }
  const scored = named
    .map((e) => ({ row: e.row, score: Math.max(...e.norms.map((n) => fuzzyScore(q, n))) }))
    .filter((s) => s.score >= FUZZY_FLOOR)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const confident = best && best.score >= FUZZY_PICK && (!second || best.score - second.score >= FUZZY_MARGIN);
  return { ...(confident ? { pick: best.row } : {}), candidates: scored.map((s) => s.row) };
}
