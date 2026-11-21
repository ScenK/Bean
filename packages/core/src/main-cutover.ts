import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { HOME_THREAD_ID } from "./desktop-chats.js";
import { postTurn } from "./prompt.js";
import type { ChatTurn, ConverseDeps } from "./converse.js";
import type { ChatopsSurface } from "./chatops/catalog.js";
import { archiveTurns, insertTurn } from "./chatops/conversation.js";
import { HISTORY_BYTE_BUDGET, SUMMARY_MAX_CHARS, SUMMARY_TURN_CHARS, formatSummaryBlock, summarize } from "./chatops/compact.js";
import { MAIN_CONVERSATION_ID, MAIN_CUTOVER_KEY } from "./main-conversation.js";

// The cutover (#999): the desktop Home and the owner's Discord and Teams DMs fold, interleaved by
// time, into one summary — the main log's first turn — and the marker that switches every surface
// onto the log is written in the same transaction. See .memory/project-main-conversation-log.md.

interface DmSource { id: string; turns: Array<{ seq: number; role: ChatTurn["role"]; content: string; created_at: string }> }
interface Sources { home?: { itemsJson: string }; dms: DmSource[] }

function readSources(db: DatabaseSync, owners: readonly { surface: ChatopsSurface; ownerId: string }[]): Sources {
  const home = db.prepare("SELECT items_json AS itemsJson FROM desktop_chats WHERE id = ?").get(HOME_THREAD_ID) as { itemsJson: string } | undefined;
  const rows = db.prepare(
    "SELECT conversation_id FROM chatops_conversations WHERE surface = ? AND (owner_id = ? OR owner_alt_id = ?) " +
      "AND kind = 'dm' AND archived_from IS NULL ORDER BY conversation_id",
  );
  const turns = db.prepare("SELECT seq, role, content, created_at FROM chatops_turns WHERE conversation_id = ? ORDER BY seq");
  const dms = owners.filter((o) => o.ownerId).flatMap((o) =>
    (rows.all(o.surface, o.ownerId, o.ownerId) as unknown as { conversation_id: string }[]).map((r): DmSource => ({
      id: r.conversation_id, turns: turns.all(r.conversation_id) as unknown as DmSource["turns"],
    })));
  return { ...(home ? { home } : {}), dms };
}

const timeOf = (at: unknown): number | undefined => {
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** Home's items (renderer-owned, read loosely) after its latest summary: typed turns, replies and
 * posts — cards and status rows carry nothing a summary needs. */
function homeTurns(itemsJson: string): { summary?: string; turns: Array<{ at?: number; turn: ChatTurn }> } {
  let items: unknown;
  try { items = JSON.parse(itemsJson); } catch { return { turns: [] }; }
  if (!Array.isArray(items)) return { turns: [] };
  const list = items as Array<Record<string, unknown> | null>;
  const last = list.findLastIndex((it) => it?.kind === "summary" && typeof it.text === "string");
  const summary = last >= 0 ? (list[last]!.text as string) : undefined;
  const turns = list.slice(last + 1).flatMap((it): Array<{ at?: number; turn: ChatTurn }> => {
    if (!it || typeof it.text !== "string" || !it.text.trim()) return [];
    const at = timeOf(it.at);
    const dated = at === undefined ? {} : { at };
    if (it.kind === "user") return [{ ...dated, turn: { role: "user", content: it.text } }];
    if (it.kind === "reply") {
      const agent = typeof it.agent === "string" && it.agent !== "bean" ? `[${it.agent}] ` : "";
      return [{ ...dated, turn: { role: "assistant", content: `${agent}${it.text}` } }];
    }
    if (it.kind === "post" && typeof it.sprout === "string") return [{ ...dated, turn: { role: "user", content: postTurn({ sprout: it.sprout, text: it.text }) } }];
    return [];
  });
  return { ...(summary ? { summary } : {}), turns };
}

/** Every source's turns in one timeline: undated desktop items first in saved order, then by time
 * (ties keep source order — Home, then each DM). */
function interleave(sources: Sources): { summary?: string; turns: ChatTurn[] } {
  const home = sources.home ? homeTurns(sources.home.itemsJson) : { turns: [] };
  const all = [
    ...home.turns,
    ...sources.dms.flatMap((d) => d.turns.map((t) => ({ at: timeOf(t.created_at), turn: { role: t.role, content: t.content } }))),
  ].map((e, i) => ({ ...e, i }));
  all.sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || a.i - b.i);
  return { ...(home.summary ? { summary: home.summary } : {}), turns: all.map((e) => e.turn) };
}

/** One summary of `turns` (folded onto `previous`), in calls of at most the desktop byte budget. */
async function foldAll(turns: ChatTurn[], previous: string | undefined, deps: ConverseDeps): Promise<string | undefined> {
  let summary = previous?.trim() ? previous.trim().slice(0, SUMMARY_MAX_CHARS) : undefined;
  let chunk: ChatTurn[] = [];
  let size = 0;
  const flush = async (): Promise<void> => {
    if (chunk.length) summary = (await summarize(chunk, deps, summary)).slice(0, SUMMARY_MAX_CHARS);
    chunk = [];
    size = 0;
  };
  for (const t of turns) {
    const n = Math.min(t.content.length, SUMMARY_TURN_CHARS);
    if (size + n > HISTORY_BYTE_BUDGET) await flush();
    chunk.push(t);
    size += n;
  }
  await flush();
  return summary;
}

export type CutoverResult = "done" | "already" | "changed";

/** Runs the cutover once: reads the sources, summarizes them (the slow part, outside any lock), then
 * in one BEGIN IMMEDIATE re-reads them and — only if nothing changed meanwhile — archives each owner
 * DM's own history (listed read-only on the desktop), writes the summary as the main log's first
 * turn and the marker (its value, the cutover time, is the status entry the desktop renders once).
 * `changed` = a source moved during the summary: nothing written, the next boot retries. A failed
 * summary call throws, leaving everything as before. The log is empty before the marker: nothing
 * writes it while it is dark. `owners` = each surface's configured owner (loadChatopsOwners). */
export async function runMainCutover(
  file: string, owners: readonly { surface: ChatopsSurface; ownerId: string }[], deps: ConverseDeps, now: () => Date = () => new Date(),
): Promise<CutoverResult> {
  const db = openDb(file);
  const marked = (): boolean => db.prepare("SELECT 1 FROM memory_meta WHERE key = ?").get(MAIN_CUTOVER_KEY) !== undefined;
  if (marked()) return "already";
  const sources = readSources(db, owners);
  const { summary: previous, turns } = interleave(sources);
  const summary = await foldAll(turns, previous, deps);
  const seen = JSON.stringify(sources);
  db.exec("BEGIN IMMEDIATE");
  try {
    let result: CutoverResult = "done";
    if (marked()) result = "already";
    else if (JSON.stringify(readSources(db, owners)) !== seen) result = "changed";
    else {
      for (const dm of sources.dms) archiveTurns(db, dm.id);
      if (summary) insertTurn(db, MAIN_CONVERSATION_ID, { role: "user", content: formatSummaryBlock(summary) });
      db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?)").run(MAIN_CUTOVER_KEY, now().toISOString());
    }
    db.exec(result === "done" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
