import { randomUUID } from "node:crypto";
import type { ConverseDeps } from "../converse.js";
import type { Memory } from "./memory.js";
import { proposeMemoryConsolidation, type ConsolidationResult } from "./consolidate.js";
import {
  applyConsolidation, claimDreamLease, countMemoriesSince, getMemoryMeta, loadMemories, releaseDreamLease,
  type DreamDigest, type DreamGroup, type DreamPlan,
} from "./store.js";

// Constants, not config knobs (#177 non-goals).
export const DREAM_MIN_HOURS = 24;
export const DREAM_MIN_NEW = 5;
const LEASE_MS = 10 * 60_000;
// ponytail: one model call over the oldest 150; chunk the list if memory ever outgrows that.
const MAX_PER_RUN = 150;

/** Code-side validation of the model's proposal — the model is only trusted to suggest:
 * merge groups must be disjoint and single-scope (a global fact never absorbs a project one, and
 * two projects never mix), text non-empty, a rewrite must actually change the text, and drops
 * are capped at max(3, 20%) per run so a buggy run can't wipe memory. */
export function planDream(memories: Memory[], result: ConsolidationResult, runId: string, at: string): DreamPlan {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const taken = new Set<string>();
  const groups: DreamGroup[] = [];
  for (const merge of result.merges) {
    const members = [...new Set(merge.ids)].map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
    const text = merge.mergedText.trim();
    if (members.length === 0 || !text || members.some((m) => taken.has(m.id))) continue;
    if (new Set(members.map((m) => m.projectPath ?? "")).size > 1) continue;
    if (members.length === 1 && members[0]!.text === text) continue;
    members.forEach((m) => taken.add(m.id));
    groups.push({ ids: members.map((m) => m.id), text, projectPath: members[0]!.projectPath });
  }
  const dropCap = Math.max(3, Math.floor(memories.length * 0.2));
  let removed = 0;
  for (const id of result.drops) {
    if (removed >= dropCap) break;
    if (!byId.has(id) || taken.has(id)) continue;
    taken.add(id);
    groups.push({ ids: [id] });
    removed++;
  }
  return {
    runId,
    groups,
    expected: [...taken].map((id) => byId.get(id)!),
    digest: {
      runId, at, removed,
      merged: groups.filter((g) => g.text !== undefined && g.ids.length > 1).length,
      rewritten: groups.filter((g) => g.text !== undefined && g.ids.length === 1).length,
    },
  };
}

export interface DreamDeps extends ConverseDeps {
  dbFile: string;
  now?: () => Date;
  /** Ids to leave alone this run — the auto-save batch whose Undo is still pending (merging it
   * would swap its ids out from under "Just remembered"). */
  exclude?: string[];
}

async function isDue(dbFile: string, now: Date): Promise<boolean> {
  const last = (await getMemoryMeta(dbFile, "lastDreamAt")) as string | undefined;
  if (last && now.getTime() - Date.parse(last) < DREAM_MIN_HOURS * 3_600_000) return false;
  // Derivable from created_at (no counter to race on); "" sorts before every ISO date.
  return (await countMemoriesSince(dbFile, last ?? "")) >= DREAM_MIN_NEW;
}

/** Background consolidation, checked on an event (after each desktop auto-save), no timer: runs
 * when ≥24h have passed since the last dream AND ≥5 memories were created since it. A lease in
 * memory_meta keeps two triggers/processes from both running; no transaction spans the model
 * call — applyConsolidation re-verifies every touched row instead. Returns the digest when
 * something changed. Never throws. */
export async function maybeDream(deps: DreamDeps): Promise<DreamDigest | undefined> {
  const now = deps.now ?? (() => new Date());
  try {
    if (!(await isDue(deps.dbFile, now()))) return undefined;
    const runId = randomUUID();
    if (!(await claimDreamLease(deps.dbFile, runId, now().getTime(), LEASE_MS))) return undefined;
    try {
      // Re-check under the lease: another run may have committed between the check and the claim.
      if (!(await isDue(deps.dbFile, now()))) return undefined;
      const skip = new Set(deps.exclude ?? []);
      const memories = (await loadMemories(deps.dbFile)).filter((m) => !skip.has(m.id)).slice(0, MAX_PER_RUN);
      const result = await proposeMemoryConsolidation(memories, { chat: deps.chat, model: deps.model });
      if (result.failed) return undefined; // an outage leaves the watermark alone — retried next close
      const plan = planDream(memories, result, runId, now().toISOString());
      // Applied even when empty: it stamps lastDreamAt so the next close doesn't re-ask the model.
      const applied = await applyConsolidation(deps.dbFile, plan, now().getTime());
      return applied && plan.groups.length > 0 ? plan.digest : undefined;
    } finally {
      await releaseDreamLease(deps.dbFile, runId);
    }
  } catch (err) {
    console.error("dream failed:", err);
    return undefined;
  }
}
