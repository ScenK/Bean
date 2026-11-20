import { HOME_JOB_ID, homeJob, type TaskStatus } from "./task-status.js";

/** How often the pending posts are re-read regardless (#961): posts another process inserted —
 * `bean-core` holding the scheduler lease on this data dir — reach no hook here. */
export const HOME_RECONCILE_MS = 60_000;
/** setTimeout's ceiling; a later expiry just recounts early and re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type Newest = { id: string; createdAt: string } | undefined;

/** The avatar's Home bubble on the local host (#961): recounted from the pending posts on insert, on
 * drain, at boot and when the soonest pending post expires — the posts are the only state. A new post
 * nudges the chat holding today's Home (a seen Home drains it; the shell hides the bubble meanwhile)
 * and moves the bubble to the newest slot. A bounded reconcile catches posts another process
 * inserted: a newer newest post is an arrival, even when the cap kept the count the same. */
export function createHomeBubble(deps: {
  count: () => number;
  newest: () => Newest;
  nextExpiry: () => string | undefined;
  status: Pick<TaskStatus, "upsert" | "dismiss">;
  /** The chat mount holding today's Home, if any. */
  homeMount: () => string | undefined;
  nudge: (mountId: string) => void;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}) {
  const timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  let expiry: ReturnType<typeof setTimeout> | undefined;
  // undefined until the first read (boot): that one sets the baseline, it isn't an arrival.
  let last: { count: number; newest: Newest } | undefined;
  const read = (): { count: number; newest: Newest; next: string | undefined } | undefined => {
    try {
      return { count: deps.count(), newest: deps.newest(), next: deps.nextExpiry() };
    } catch (err) {
      console.error("bean: counting Home posts failed", err);
      return undefined;
    }
  };
  const show = (r: NonNullable<ReturnType<typeof read>>, newest: boolean): void => {
    last = { count: r.count, newest: r.newest };
    if (r.count === 0) deps.status.dismiss(HOME_JOB_ID);
    else deps.status.upsert(HOME_JOB_ID, homeJob(r.count), newest);
    if (expiry !== undefined) timers.clear(expiry);
    expiry = r.next === undefined ? undefined
      : timers.set(() => refresh(), Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(r.next!) - Date.now()) + 50));
  };
  const isNewer = (a: Newest, b: Newest): boolean =>
    a !== undefined && (b === undefined || a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id !== b.id));
  /** Every recount (insert, drain, boot, expiry, reconcile) goes through here, so whichever runs first
   * after a post landed — even another process's — treats it as an arrival: nudge, newest slot. */
  const refresh = (): void => {
    const r = read();
    if (!r) return;
    if (last !== undefined && isNewer(r.newest, last.newest)) {
      const mount = deps.homeMount();
      if (mount !== undefined) deps.nudge(mount);
      show(r, true);
    } else show(r, false);
  };
  const reconcile = setInterval(refresh, HOME_RECONCILE_MS);
  return {
    refresh,
    /** A post was inserted here. */
    posted: refresh,
    stop: (): void => {
      clearInterval(reconcile);
      if (expiry !== undefined) timers.clear(expiry);
    },
  };
}
