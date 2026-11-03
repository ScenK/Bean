// packages/core/src/sprout-trigger.ts
// Node-free (exported as `@bean/core/sprout-trigger`) so the Sprouts panel, chat cards and the
// scheduler all pick run vs check by the same rule.
import type { Routine, RunStatus } from "./routine-store.js";
import type { TriggerResult } from "./routine-scheduler.js";

/** What triggering a saved sprout means right now. A watch drains through its queue, so with
 * nothing queued (or no steps at all) the useful action is checking its source; everything
 * else runs. `pendingCount` = the sprout's pending todos. */
export function sproutTriggerAction(routine: Routine, pendingCount: number): "run" | "check" {
  if (!routine.watch) return "run";
  return routine.steps.length > 0 && routine.todoDriven && pendingCount > 0 ? "run" : "check";
}

/** What a sprout-run confirm card does, decided when Bean proposes it and frozen on the card:
 * a tap triggers exactly this action. */
export interface SproutRunPlan {
  routine: string;
  action: "run" | "check";
  /** "Runs its steps once now" / "Works through 3 queued todos" / "Checks <source> now". */
  actionLine: string;
  /** Where results go, from the sprout's sinks. */
  resultsTo: string;
  /** A paused schedule sprout: it runs once and stays paused. */
  paused: boolean;
  /** A check queues new items (steps) rather than only sending them on (notify-only). */
  queuesNew: boolean;
}

/** Why there's no card: a paused watch, a watch that was never reviewed, or a todo sprout with
 * nothing queued. Each surface words its own reply. */
export type SproutRunBlock = "off" | "review" | "empty";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function resultsTo(r: Routine): string {
  const out: string[] = [...new Set((r.sinks.chatops ?? []).map((s) => (s.transport === "teams" ? "Teams" : "Discord")))];
  if (r.sinks.note) out.push("a note");
  if (r.sinks.notify) out.push("a desktop notification");
  return out.length > 0 ? out.join(", ") : "the run history only";
}

/** The card for "run the X sprout", from the saved definition, its pending todos, and whether a
 * watch's seen-set is seeded. */
export function planSproutRun(r: Routine, pendingCount: number, seeded: boolean): { plan: SproutRunPlan } | { blocked: SproutRunBlock } {
  if (r.watch && !r.enabled) return { blocked: seeded ? "off" : "review" };
  const action = sproutTriggerAction(r, pendingCount);
  if (action === "run" && r.todoDriven && pendingCount === 0) return { blocked: "empty" };
  const w = r.watch;
  const actionLine = action === "check" && w
    ? `Checks ${w.kind === "feed" ? w.url : "its command"} now${w.window ? ", even outside its window" : ""}`
    : r.todoDriven ? `Works through ${plural(pendingCount, "queued todo")}` : "Runs its steps once now";
  return {
    plan: {
      routine: r.name, action, actionLine, resultsTo: resultsTo(r),
      paused: !r.enabled, queuesNew: Boolean(w && r.steps.length > 0),
    },
  };
}

/** A check's result as one short line: "3 new — queued", "nothing new", or the error. */
export function sproutCheckText(result: { newItems: number; error?: string }, queuesNew: boolean): string {
  if (result.error) return result.error;
  if (result.newItems === 0) return "nothing new";
  return `${result.newItems} new — ${queuesNew ? "queued" : "sent"}`;
}

/** The one fixed line a chat posts when a run it started ends — never step output. */
export function sproutFinishText(name: string, status: RunStatus): string {
  if (status === "ok") return `${name} finished ✓`;
  return status === "needs-attention" ? `${name} needs attention ⚠` : `${name} failed ✗ · see Dashboard`;
}

/** Run or check a sprout for a chat, finish reply going to `origin` (`channel` absent = the
 * owner's DM). What a bot's `routines.sprouts.trigger` is. */
export type SproutTrigger = (name: string, action: "run" | "check", origin: { channel?: string }) => Promise<TriggerResult>;

/** Wraps the scheduler's trigger so a run started from chat posts one fixed line where it was
 * asked once it ends (#636): a channel post, not an interaction follow-up (those expire). Used by
 * whichever process hosts the scheduler — headless Discord, or the app for a bot it spawned. */
export function withFinishReply(
  trigger: (name: string, action: "run" | "check") => Promise<TriggerResult>,
  enqueue: (msg: { channel?: string; body: string }) => Promise<unknown>,
): SproutTrigger {
  return async (name, action, origin) => {
    const t = await trigger(name, action);
    if (t.status === "started") {
      void t.done.then((o) => enqueue({ ...origin, body: sproutFinishText(name, o.status) }))
        .catch((err: unknown) => console.error(`bean: finish reply for "${name}" failed`, err));
    }
    return t;
  };
}
