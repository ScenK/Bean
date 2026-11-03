// packages/core/src/sprout-trigger.ts
// Node-free (exported as `@bean/core/sprout-trigger`) so the Sprouts panel, chat cards and the
// scheduler all pick run vs check by the same rule.
import type { Routine } from "./routine-store.js";

/** What triggering a saved sprout means right now. A watch drains through its queue, so with
 * nothing queued (or no steps at all) the useful action is checking its source; everything
 * else runs. `pendingCount` = the sprout's pending todos. */
export function sproutTriggerAction(routine: Routine, pendingCount: number): "run" | "check" {
  if (!routine.watch) return "run";
  return routine.steps.length > 0 && routine.todoDriven && pendingCount > 0 ? "run" : "check";
}
