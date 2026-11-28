import {
  PULSE_CADENCE_MINUTES, effectiveProactivity, homePostBody, insertHomePost, isQuietHours, loadPulseState, notePulsePosted,
  outboxErrorLine, postTurnKey, type OutboxMessage, type Proactivity, type PulseResult,
} from "@bean/core";

// The proactive brain's scheduler (#1157): core's `runProactivePulse` on the level's cadence, under
// the scheduler lease, and delivery of what it says as Bean's own Home post (+ owner-DM copies).

/** Dormant until the Settings dial ships (#1158): the default level is `medium`, and pulses must not
 * start before the owner can see and turn the dial. */
export const PULSE_LIVE = false;

const CHECK_EVERY_MS = 10 * 60_000;

export interface PulseDelivery {
  dbFile: string;
  /** The persona's name: the post's author label (`home_posts.sprout`). */
  name: () => string;
  /** A post landed: the host recounts the avatar's Home bubble. */
  onHomePost: () => void;
  /** Config `homeDiscordDm` / `homeTeamsDm`, read per delivery. */
  homeDms: () => { discord: boolean; teams: boolean };
  /** core `sinkRecipients`: which owner DMs are reachable (0 / absent = not). */
  reach: () => Promise<{ discord?: number; teams?: number }>;
  enqueue: (msg: Omit<OutboxMessage, "id" | "createdAt">) => Promise<string>;
}

/** Bean's check-in as a Home post (`kind: "pulse"`) and its owner-DM copies: no `Sprout:` title, the
 * same `post:<id>` main-log key as the drain, logged as Bean's turn on either path. Returns the post id. */
export async function deliverPulsePost(d: PulseDelivery, text: string): Promise<string> {
  const id = insertHomePost(d.dbFile, { sprout: d.name(), body: text, kind: "pulse" });
  d.onHomePost();
  const dms = d.homeDms();
  const phone = (["discord", "teams"] as const).filter((t) => dms[t]);
  const reach = phone.length > 0 ? await d.reach() : {};
  for (const transport of phone) {
    // Unreachable (no owner set / owner's chat unknown) = nothing enqueued, never a retry pile.
    if (!reach[transport]) continue;
    try {
      await d.enqueue({ transport, body: homePostBody(text), context: true, mainTurnKey: postTurnKey(id), kind: "pulse" });
    } catch (err) {
      // One DM failing must not cost the other its copy; Home already has the post.
      console.error(`bean: pulse DM copy enqueue failed (${transport}):`, outboxErrorLine(err));
    }
  }
  return id;
}

export interface PulseLoopDeps extends PulseDelivery {
  /** The scheduler lease (and no core update in progress): a host without it runs nothing. */
  canRun: () => boolean;
  /** The Settings dial, read per check; unreadable = off. */
  proactivity: () => Promise<Proactivity>;
  /** One reflection pass at this dial (core `runProactivePulse`). */
  pulse: (dial: Proactivity, signal: AbortSignal) => Promise<PulseResult>;
  now?: () => Date;
}

export type PulseCheck = "standby" | "off" | "quiet-hours" | "not-due" | PulseResult;

/** Runs a pass when one is due and delivers what it says. `memo.lastTry` (ms) spaces a failing pass
 * out like a good one — it never retries before the cadence. */
export async function runPulseIfDue(deps: PulseLoopDeps, memo: { lastTry: number }, signal: AbortSignal): Promise<PulseCheck> {
  const now = (): Date => deps.now?.() ?? new Date();
  if (!deps.canRun()) return "standby";
  const dial = await deps.proactivity();
  if (dial === "off") return "off";
  // No pass overnight: nothing could be posted, and a step-down notice would be lost with it.
  if (isQuietHours(now())) return "quiet-hours";
  const state = loadPulseState(deps.dbFile);
  const last = Math.max(state.lastPulseAt ? Date.parse(state.lastPulseAt) : 0, memo.lastTry);
  if (now().getTime() - last < PULSE_CADENCE_MINUTES[effectiveProactivity(dial, state)] * 60_000) return "not-due";
  memo.lastTry = now().getTime();
  const result = await deps.pulse(dial, signal);
  // Re-checked after the model call: a lost lease, the dial turned off, or 22:00 passing posts nothing.
  if (signal.aborted || !deps.canRun()) return result;
  const dialNow = await deps.proactivity();
  if (dialNow === "off" || isQuietHours(now()) || !deps.canRun()) return result;
  // The owner moved the dial meanwhile: their choice already ended this step-down, so no notice.
  if (result.announcement && dialNow === dial) await deliverPulsePost(deps, result.announcement);
  if (result.post) {
    await deliverPulsePost(deps, result.post);
    notePulsePosted(deps.dbFile, now());
  }
  return result;
}

/** Checks now and every 10 minutes after, one pass at a time. Returns the stop (aborts a running pass). */
export function startPulse(deps: PulseLoopDeps): () => void {
  const memo = { lastTry: 0 };
  const ctl = new AbortController();
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    runPulseIfDue(deps, memo, ctl.signal)
      .catch((err: unknown) => { if (!ctl.signal.aborted) console.error("bean: proactive pulse failed", err); })
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, CHECK_EVERY_MS);
  return () => {
    clearInterval(timer);
    ctl.abort();
  };
}
