import { useEffect, useState } from "preact/hooks";
import type { MindItem } from "@bean/core";

// Seeds in Home (#1159): Bean's own working list, read through the local-only `listSeeds`. One store
// per window, shared by the Home header chip/popover and the sidebar's Home row. No push protocol:
// it's re-read on Home open, window focus, and after Home drains a post.

/** `enabled` = the dial isn't off and the core answered (a remote core can't list seeds: hidden).
 * `planting` = the sprouts opted in to plant seeds (`feedBrain`), so the empty state stops asking. */
export interface SeedsView { enabled: boolean; items: MindItem[]; planting: string[] }

const HIDDEN: SeedsView = { enabled: false, items: [], planting: [] };
let view: SeedsView = HIDDEN;
const subs = new Set<(v: SeedsView) => void>();
let seq = 0;

const set = (v: SeedsView): void => { view = v; for (const s of subs) s(v); };

/** Re-reads the dial and the list; only the latest read counts. Any failure hides Seeds. */
export function refreshSeeds(): void {
  const mine = ++seq;
  Promise.resolve()
    .then(() => window.bean.getConfig())
    .then(async (c): Promise<SeedsView> => (!c.proactivity || c.proactivity === "off" ? HIDDEN : {
      enabled: true,
      items: await window.bean.listSeeds(),
      // A failed Sprouts read only costs the empty state's wording, not Seeds.
      planting: (await window.bean.routinesList().catch(() => [])).filter((r) => r.feedBrain === true).map((r) => r.name),
    }))
    .then((v) => { if (mine === seq) set(v); }, () => { if (mine === seq) set(HIDDEN); });
}

/** The shared view; refreshes on mount and on every window focus. */
export function useSeeds(): SeedsView {
  const [v, setV] = useState(view);
  useEffect(() => {
    subs.add(setV);
    refreshSeeds();
    window.addEventListener("focus", refreshSeeds);
    return () => { subs.delete(setV); window.removeEventListener("focus", refreshSeeds); };
  }, []);
  return v;
}

/** The popover's cap on active seeds shown (core keeps at most MIND_ACTIVE_CAP = 10). */
export const SEEDS_SHOWN = 10;

export const activeSeeds = (items: readonly MindItem[]): MindItem[] => items.filter((s) => s.status === "active");

/** Quiet hours, 22:00–07:00 local — keep in step with core pulse.ts `isQuietHours` (node-only module). */
export const isQuietHours = (d: Date): boolean => d.getHours() >= 22 || d.getHours() < 7;

/** The sidebar Home row's sub-label. */
export const homeSubLabel = (v: SeedsView): string => {
  const n = v.enabled ? activeSeeds(v.items).length : 0;
  return n > 0 ? `Watching ${n} seed${n === 1 ? "" : "s"}` : "Superagent";
};

/** Discuss: the editable reference the Home composer is prefilled with. */
export const discussText = (seed: MindItem): string => `About "${seed.text}": `;

/** Seeds the pulse crossed off from the owner's reply (done, and its last write was the pulse's) that
 * the popover hasn't shown yet — each is shown struck through once, with Undo. */
export const replyCrossed = (items: readonly MindItem[], seen: ReadonlySet<string>): MindItem[] =>
  items.filter((s) => s.status === "done" && s.reconciledAt !== undefined && s.reconciledAt === s.updatedAt && !seen.has(`${s.id}:${s.version}`));

const SEEN_KEY = "bean.seeds.replyCrossedSeen";
const SEEN_MAX = 100;

/** The reply-crossed seeds already shown (renderer view state, localStorage; bounded). */
export function readSeen(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

export function markSeen(keys: readonly string[]): void {
  if (keys.length === 0) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...readSeen(), ...keys])].slice(-SEEN_MAX))); } catch { /* view state only */ }
}
