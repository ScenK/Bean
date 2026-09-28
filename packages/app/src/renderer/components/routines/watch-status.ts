import type { Routine } from "@bean/core";
import type { RoutineStateView } from "../../../ipc.js";

// Wording for watch routines, shared by the Routines panel (2d) and the Dashboard (2e). Pure so
// it's unit-tested; the panels only render it.

export const ALARM_AFTER = 3; // mirrors routine-scheduler.ts — the panel escalates when the alarm fires
const DEFAULT_WATCH_MINUTES = 15; // mirrors routine-store.ts (renderer can't import its values)

export const everyMinutes = (r: Routine): number => r.watch?.everyMinutes ?? DEFAULT_WATCH_MINUTES;

export function agoText(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Failures in a row. The counter is in-memory in main, so after a restart a stored pollError
 * still counts as (at least) the first failure. */
export const failureCount = (s: RoutineStateView | undefined): number =>
  Math.max(s?.pollFailures ?? 0, s?.pollError ? 1 : 0);

export const needsReview = (r: Routine, s: RoutineStateView | undefined): boolean =>
  Boolean(r.watch && !r.enabled && s?.seeded === false);

export interface WatchStatus { tone: "ok" | "warn" | "bad" | "off"; text: string; detail?: string }

/** The panel's status line (takes the "next run" slot). Shows the error from the FIRST failure,
 * with the next retry; turns red once the 3-in-a-row alarm has fired. */
export function watchStatusLine(r: Routine, s: RoutineStateView | undefined, now: Date): WatchStatus {
  const every = `Checks every ${everyMinutes(r)} min`;
  if (!r.enabled) return { tone: "off", text: needsReview(r, s) ? "Not checking yet — Enable to start" : "Paused — won't check until you enable it" };
  const fails = failureCount(s);
  if (fails >= ALARM_AFTER) {
    return { tone: "bad", text: `Last ${fails} checks failed · ${agoText(s?.lastPoll, now)}`, ...(s?.pollError ? { detail: s.pollError } : {}) };
  }
  if (fails > 0) {
    const retryAt = s?.lastPoll ? new Date(s.lastPoll).getTime() + everyMinutes(r) * 60_000 : now.getTime();
    const retryIn = Math.max(0, Math.round((retryAt - now.getTime()) / 60000));
    return {
      tone: "warn",
      text: `Last check failed · ${agoText(s?.lastPoll, now)} · retrying ${retryIn > 0 ? `in ${retryIn}m` : "soon"}`,
      ...(s?.pollError ? { detail: s.pollError } : {}),
    };
  }
  if (!s?.lastPoll) return { tone: "ok", text: `${every} · not checked yet` };
  const checked = `last checked ${agoText(s.lastPoll, now)}`;
  if (r.steps.length === 0) {
    const lastFire = s.history[0]?.startedAt;
    return { tone: "ok", text: `${every} · ${checked} · ${lastFire ? `last new item ${agoText(lastFire, now)}` : "nothing new yet"}` };
  }
  const queued = (s.queue?.pending ?? 0) + (s.queue?.running ?? 0);
  return { tone: "ok", text: `${every} · ${checked} · ${queued > 0 ? `${queued} queued` : "nothing new"}` };
}

/** List-row caption: "Watch · 5m · ⚡ todo-driven", "Watch · 15m · notify only", "… · check failing". */
export function watchRowSub(r: Routine, s: RoutineStateView | undefined): { text: string; bad: boolean } {
  if (needsReview(r, s)) return { text: "needs review · Enable to start", bad: false };
  const base = `Watch · ${everyMinutes(r)}m`;
  if (!r.enabled) return { text: `${base} · paused`, bad: false };
  if (failureCount(s) > 0) return { text: `${base} · check failing`, bad: true };
  return { text: `${base} · ${r.steps.length === 0 ? "notify only" : "⚡ todo-driven"}`, bad: false };
}

/** Dashboard nextRunText for a watch (2e): what it's waiting for, the queue while it works, and
 * the error only once the 3-failure alarm has fired. */
export function watchDashboardText(r: Routine, s: RoutineStateView | undefined, now: Date): string {
  if (failureCount(s) >= ALARM_AFTER) {
    return `can't check the ${r.watch?.kind === "feed" ? "feed" : "source"} · failing since ${agoText(s?.lastPoll, now)}`;
  }
  const runningItems = s?.queue?.running ?? 0;
  if (runningItems > 0) {
    return `running ${runningItems} item${runningItems === 1 ? "" : "s"} now · ${s?.queue?.pending ?? 0} queued`;
  }
  return s?.lastPoll ? `watching for new items · checked ${agoText(s.lastPoll, now)}` : "watching for new items · not checked yet";
}
