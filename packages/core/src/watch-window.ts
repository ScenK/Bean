// packages/core/src/watch-window.ts
// Node-free (exported as `@bean/core/watch-window`) so the scheduler, the Routines panel, and
// the Dashboard all read the same window math.

/** Local-time window a watch's scheduled polls run in. `from` inclusive, `to` exclusive;
 * absent `to` = until midnight; `from > to` crosses midnight. Manual checks ignore it. */
export interface WatchWindow { from: string; to?: string }

export const WATCH_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function describeWatchWindowError(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return "watch window must be an object";
  const w = v as Record<string, unknown>;
  if (typeof w.from !== "string" || !WATCH_TIME.test(w.from)) return "watch window needs a start time (HH:MM)";
  if (w.to !== undefined && (typeof w.to !== "string" || !WATCH_TIME.test(w.to))) return "watch window end must be HH:MM";
  if (w.to === w.from) return "watch window start and end can't be the same time";
  return null;
}

/** True when `at` (local time) falls in the window; no window = always. */
export function inWatchWindow(w: WatchWindow | undefined, at: Date): boolean {
  if (!w) return true;
  const t = at.getHours() * 60 + at.getMinutes();
  const from = minutes(w.from);
  const to = w.to === undefined ? 1440 : minutes(w.to);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** `at` itself when inside the window, else the window's next opening after `at`. */
export function nextWindowStart(w: WatchWindow | undefined, at: Date): Date {
  if (inWatchWindow(w, at)) return at;
  // Walk forward a minute at a time with the same test the scheduler uses, so DST jumps and
  // repeated hours can't make this disagree with when polling actually resumes.
  const d = new Date(at);
  d.setSeconds(0, 0);
  for (let i = 0; i < 2 * 1440; i++) {
    d.setTime(d.getTime() + 60_000);
    if (inWatchWindow(w, d)) return d;
  }
  return d;
}

/** Window length in minutes (open end runs to midnight; wraps across it). */
export function watchWindowMinutes(w: WatchWindow): number {
  const from = minutes(w.from);
  return w.to === undefined ? 1440 - from : (minutes(w.to) - from + 1440) % 1440;
}

/** "20:00–06:00", or "from 20:00" for an open end. */
export const watchWindowText = (w: WatchWindow): string => (w.to === undefined ? `from ${w.from}` : `${w.from}–${w.to}`);
