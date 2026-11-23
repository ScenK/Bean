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

/** The per-bot "Home posts also go to the owner's DM" settings (#1067). */
export interface HomeDms { discord: boolean; teams: boolean }

/** The owner DMs a Home post is copied to: "your Discord DM", "your Discord and Teams DMs", or "". */
export function homeDmNames(dms?: HomeDms): string {
  const phone = (["discord", "teams"] as const).filter((t) => dms?.[t]).map((t) => (t === "discord" ? "Discord" : "Teams"));
  return phone.length === 0 ? "" : `your ${phone.join(" and ")} DM${phone.length > 1 ? "s" : ""}`;
}

/** Where a sprout's Home post lands (#1069), the one wording for the run card, the Sprouts footer
 * and the builder review: "your chat with <name>", plus the owner DMs it's copied to. */
export function homeDestination(beanName: string, dms?: HomeDms): string {
  const dm = homeDmNames(dms);
  return `your chat with ${beanName}${dm ? ` and ${dm}` : ""}`;
}

/** What a sprout-run confirm card does, decided when Bean proposes it and frozen on the card:
 * a tap triggers exactly this action. */
export interface SproutRunPlan {
  routine: string;
  action: "run" | "check";
  /** "Runs its steps once now" / "Works through 3 queued todos" / "Checks <source> now". */
  actionLine: string;
  /** Where results go, from the sprout's sinks; a run's result also comes back to the chat that asked. */
  resultsTo: string;
  /** A disabled schedule sprout — on demand: it runs once now and keeps no schedule. */
  paused: boolean;
  /** A check queues new items (steps) rather than only sending them on (notify-only). */
  queuesNew: boolean;
}

/** Why there's no card: a paused watch, a watch that was never reviewed, or a todo sprout with
 * nothing queued. Each surface words its own reply. */
export type SproutRunBlock = "off" | "review" | "empty";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function resultsTo(r: Routine, action: "run" | "check", home: string): string {
  const out: string[] = [...new Set((r.sinks.chatops ?? []).map((s) => (s.transport === "teams" ? "Teams" : "Discord")))];
  if (r.sinks.note) out.push("a note");
  if (r.sinks.notify) out.push("a desktop notification");
  if (r.sinks.home) out.push(home);
  // A run's end comes back to the chat that started it (#921); a check's doesn't.
  if (action === "run") return out.length > 0 ? `this chat, ${out.join(", ")}` : "this chat";
  return out.length > 0 ? out.join(", ") : "the run history only";
}

/** The card for "run the X sprout", from the saved definition, its pending todos, and whether a
 * watch's seen-set is seeded. `home` = homeDestination's wording for a Home post. */
export function planSproutRun(r: Routine, pendingCount: number, seeded: boolean, home = homeDestination("Bean")): { plan: SproutRunPlan } | { blocked: SproutRunBlock } {
  if (r.watch && !r.enabled) return { blocked: seeded ? "off" : "review" };
  const action = sproutTriggerAction(r, pendingCount);
  if (action === "run" && r.todoDriven && pendingCount === 0) return { blocked: "empty" };
  const w = r.watch;
  const actionLine = action === "check" && w
    ? `Checks ${w.kind === "feed" ? w.url : "its command"} now${w.window ? ", even outside its window" : ""}`
    : r.todoDriven ? `Works through ${plural(pendingCount, "queued todo")}` : "Runs its steps once now";
  return {
    plan: {
      routine: r.name, action, actionLine, resultsTo: resultsTo(r, action, home),
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

/** The one fixed line a chat posts when a run it started ends — never step output.
 * `interrupted` = Bean restarted before the run ended; nothing was re-run. */
export function sproutFinishText(name: string, status: RunStatus | "interrupted"): string {
  if (status === "ok") return `${name} finished ✓`;
  if (status === "interrupted") return `${name} was interrupted ✗ · Bean restarted before it finished, nothing was re-run`;
  return status === "needs-attention" ? `${name} needs attention ⚠` : `${name} failed ✗ · see Dashboard`;
}

/** Run or check a sprout for a chat, the result going to `origin` (`channel` absent = the
 * owner's DM; `actor` = who tapped). What a bot's `routines.sprouts.trigger` is; the scheduler
 * host records the dispatch (`withDispatch`, dispatch-store.ts) and names it by `jobId`. */
export type SproutTrigger = (name: string, action: "run" | "check", origin: SproutOrigin) => Promise<TriggerResult & { jobId?: string }>;
/** `keepBrief: false` = an off-the-record desktop chat: the dispatch never stores the run's brief. */
export interface SproutOrigin { channel?: string; actor?: string; keepBrief?: boolean }
