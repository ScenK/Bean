import { HOME_JOB_ID, homeJob, type TaskStatus } from "./task-status.js";

/** How long a new post waits for an open Home to drain it before the bubble shows (#961). */
export const HOME_ARRIVAL_GRACE_MS = 5_000;
/** How often the count is re-read regardless (#961): posts another process inserted — `bean-core`
 * holding the scheduler lease on this data dir — reach no hook here. */
export const HOME_RECONCILE_MS = 60_000;
/** setTimeout's ceiling; a later expiry just recounts early and re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The avatar's Home bubble on the local host (#961): recounted from the pending posts on insert, on
 * drain, at boot and when the soonest pending post expires — the count is the only state. A new post
 * nudges the chat holding today's Home (a shown Home drains it at once) and moves the bubble to the
 * newest slot. A bounded reconcile catches posts another process inserted. */
export function createHomeBubble(deps: {
  count: () => number;
  nextExpiry: () => string | undefined;
  status: Pick<TaskStatus, "upsert" | "dismiss">;
  /** The chat mount holding today's Home, if any. */
  homeMount: () => string | undefined;
  nudge: (mountId: string) => void;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}) {
  const timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  const refresh = (newest = false): void => {
    let n: number;
    let next: string | undefined;
    try {
      n = deps.count();
      next = deps.nextExpiry();
    } catch (err) {
      console.error("bean: counting Home posts failed", err);
      return;
    }
    last = n;
    if (n === 0) deps.status.dismiss(HOME_JOB_ID);
    else deps.status.upsert(HOME_JOB_ID, homeJob(n), newest);
    if (expiry !== undefined) timers.clear(expiry);
    expiry = next === undefined ? undefined
      : timers.set(() => refresh(), Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next) - Date.now()) + 50));
  };
  /** A post was inserted. */
  const posted = (): void => {
    const mount = deps.homeMount();
    if (mount === undefined) return refresh(true);
    deps.nudge(mount);
    // ponytail: a grace period, not a "Home is shown" signal — the host can't see visibility; a shown
    // Home drains within it (its save recounts to zero), a hidden one doesn't and the bubble shows.
    if (grace !== undefined) timers.clear(grace);
    grace = timers.set(() => { grace = undefined; refresh(true); }, HOME_ARRIVAL_GRACE_MS);
  };
  const reconcile = setInterval(() => {
    if (grace !== undefined) return; // a post's own grace is running
    let n: number;
    try { n = deps.count(); } catch { return; }
    if (n > last) posted(); // new posts from elsewhere: treated as an arrival
    else if (n !== last) refresh();
  }, HOME_RECONCILE_MS);
  return {
    refresh: (): void => refresh(),
    posted,
    stop: (): void => {
      clearInterval(reconcile);
      if (expiry !== undefined) timers.clear(expiry);
      if (grace !== undefined) timers.clear(grace);
    },
  };
}
