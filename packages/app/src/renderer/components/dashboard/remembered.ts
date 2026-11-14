import type { Memory } from "@bean/core";
import { localDate } from "./runs.js";

/** How many local days back the Remembered section reaches; everything older is in Persona. */
export const REMEMBERED_DAYS = 7;

/** One local day of saved memories — the Dashboard's Remembered entry (#860). */
export interface RememberedDay {
  /** `remembered:${date}` — a selection key that can't collide with a run bucket's `${date}|…`. */
  key: string;
  /** Local `YYYY-MM-DD`, like `RunBucket.date`. */
  date: string;
  /** Newest first. */
  rows: Memory[];
}

/** The daily digest's rows by local day, read live from the memory list: rows the owner may see
 * (shared, or private to one of `ownerIds` — never another member's, same rule as
 * `memoriesSavedBetween`), saved in the last `REMEMBERED_DAYS` local days. Newest day first;
 * a day with no rows has no entry. */
export function rememberedDays(memories: Memory[], ownerIds: string[], now: Date = new Date()): RememberedDay[] {
  const from = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (REMEMBERED_DAYS - 1)).toISOString());
  const byDate = new Map<string, Memory[]>();
  const visible = memories
    .filter((m) => !m.subjectId || ownerIds.includes(m.subjectId))
    .filter((m) => !Number.isNaN(Date.parse(m.createdAt)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const m of visible) {
    const date = localDate(m.createdAt);
    if (date < from) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), m]);
  }
  return [...byDate].map(([date, rows]) => ({ key: `remembered:${date}`, date, rows }));
}
