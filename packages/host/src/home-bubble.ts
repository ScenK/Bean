import { DEFAULT_PERSONA } from "@bean/core";
import { HOME_JOB_ID, homeJob, type TaskStatus } from "./task-status.js";

/** How often the pending count is re-read regardless (#961): a standby host (another process holds
 * the scheduler lease on this data dir and inserts the posts) gets no insert hook. */
export const HOME_RECONCILE_MS = 60_000;
/** setTimeout's ceiling; a later expiry just recounts early and re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The avatar's Home bubble on the local host (#961): the pending count is the only state. Recounted
 * on insert, on drain, at boot, when the soonest pending post expires and on a bounded poll; shown
 * while the count is above zero, removed at zero. A failed count leaves the bubble as it was. */
export function createHomeBubble(deps: {
  count: () => number;
  nextExpiry: () => string | undefined;
  /** The persona's name, re-read on every recount (#1001). */
  name?: () => string;
  status: Pick<TaskStatus, "upsert" | "dismiss">;
}) {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    let count: number;
    let next: string | undefined;
    try {
      count = deps.count();
      next = deps.nextExpiry();
    } catch (err) {
      console.error("bean: counting Home posts failed", err);
      return;
    }
    if (count === 0) deps.status.dismiss(HOME_JOB_ID);
    else deps.status.upsert(HOME_JOB_ID, homeJob(count, deps.name?.() ?? DEFAULT_PERSONA.name));
    clearTimeout(expiry);
    expiry = next === undefined ? undefined
      : setTimeout(refresh, Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next) - Date.now()) + 50));
  };
  const poll = setInterval(refresh, HOME_RECONCILE_MS);
  return {
    refresh,
    stop: (): void => {
      clearInterval(poll);
      clearTimeout(expiry);
    },
  };
}
