// Sprout trigger bridge (#637): a bot the desktop app spawned has no scheduler (the app owns it),
// so its sprout-run card asks the app over the bot's Node IPC slot. Beside desk.ts and in the same
// shape: a request/answer pair, each side's parser rebuilding the message from known fields.
// Bot → app carries a sprout name, the action frozen on the card and the asking conversation's id
// — never message text. App → bot carries a status, a fixed refusal code, or a check's count.
import { randomUUID } from "node:crypto";
import type { Routine } from "../routine-store.js";
import type { TriggerResult, WatchCheckResult } from "../routine-scheduler.js";
import { planSproutRun, type SproutTrigger } from "../sprout-trigger.js";
import { listTodos } from "../todo-store.js";
import { isWatchSeeded } from "../watch-store.js";
import { watchSourceKey } from "../watch.js";

/** What a bot's card tap gets back: TriggerResult minus the run's `done` (which stays with the
 * scheduler host — it posts the finish reply itself). */
export type SproutTriggerAnswer = { status: "started" } | Exclude<TriggerResult, { status: "started" }>;

/** Why the app refused a bridged trigger. A fixed set: the bot words each itself. */
export const ROUTINE_TRIGGER_REFUSALS = ["missing", "changed", "off", "review", "empty", "busy", "unavailable"] as const;
export type RoutineTriggerRefusal = (typeof ROUTINE_TRIGGER_REFUSALS)[number];

export type RoutineTrigger = {
  type: "routine-trigger"; requestId: string; name: string; action: "run" | "check"; origin: { channel?: string };
};
export type RoutineTriggerAnswer =
  | { status: "started" }
  | { status: "refused"; reason: RoutineTriggerRefusal }
  | { status: "checked"; newItems: number; error?: string };
export type RoutineTriggerResult = { type: "routine-trigger-result"; requestId: string } & RoutineTriggerAnswer;

// Transport ceilings: past these a message is malformed and dropped.
const MAX_ID = 200;
const MAX_ERROR = 500;

const fields = (v: unknown, type: string): Record<string, unknown> | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return o.type === type ? o : undefined;
};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** Bot → app, validated in the app. */
export function parseRoutineTrigger(v: unknown): RoutineTrigger | undefined {
  const o = fields(v, "routine-trigger");
  if (!o || !id(o.requestId) || !id(o.name) || (o.action !== "run" && o.action !== "check")) return undefined;
  if (typeof o.origin !== "object" || o.origin === null) return undefined;
  const { channel } = o.origin as Record<string, unknown>;
  if (channel !== undefined && !id(channel)) return undefined;
  return { type: "routine-trigger", requestId: o.requestId, name: o.name, action: o.action, origin: channel === undefined ? {} : { channel } };
}

/** App → bot, validated in the bot. */
export function parseRoutineTriggerResult(v: unknown): RoutineTriggerResult | undefined {
  const o = fields(v, "routine-trigger-result");
  if (!o || !id(o.requestId)) return undefined;
  const base = { type: "routine-trigger-result" as const, requestId: o.requestId };
  if (o.status === "started") return { ...base, status: "started" };
  if (o.status === "refused" && (ROUTINE_TRIGGER_REFUSALS as readonly unknown[]).includes(o.reason)) {
    return { ...base, status: "refused", reason: o.reason as RoutineTriggerRefusal };
  }
  if (o.status === "checked" && Number.isSafeInteger(o.newItems) && (o.newItems as number) >= 0) {
    if (o.error === undefined) return { ...base, status: "checked", newItems: o.newItems as number };
    if (typeof o.error === "string" && o.error.length <= MAX_ERROR) return { ...base, status: "checked", newItems: o.newItems as number, error: o.error };
  }
  return undefined;
}

/** A sprout's pending todos and whether its watch is seeded — planSproutRun's facts, read
 * straight from bean.db (any process on this ~/.bean can, scheduler host or not). */
export async function sproutRunFacts(dbPath: string, r: Routine): Promise<{ pending: number; seeded: boolean }> {
  return {
    pending: (await listTodos(dbPath, r.name)).filter((t) => t.status === "pending").length,
    seeded: r.watch ? isWatchSeeded(dbPath, r.name, watchSourceKey(r.watch)) : true,
  };
}

/** App side: answers a bot's trigger. The card was planned in the bot, so the name is re-resolved
 * here (renamed or deleted = `missing`) and the frozen action re-planned: a sprout whose plan
 * changed since the card (now paused, emptied, or run ↔ check) is refused, never run as
 * something the owner didn't confirm. `trigger` is the scheduler's, finish reply included. */
export async function answerRoutineTrigger(req: RoutineTrigger, deps: {
  load: () => Promise<Routine[]>;
  facts: (r: Routine) => Promise<{ pending: number; seeded: boolean }>;
  trigger: SproutTrigger;
}): Promise<RoutineTriggerAnswer> {
  const routine = (await deps.load()).find((r) => r.name === req.name);
  if (!routine) return { status: "refused", reason: "missing" };
  const { pending, seeded } = await deps.facts(routine);
  const out = planSproutRun(routine, pending, seeded);
  if ("blocked" in out) return { status: "refused", reason: out.blocked };
  if (out.plan.action !== req.action) return { status: "refused", reason: "changed" };
  const t = await deps.trigger(routine.name, req.action, req.origin);
  if (t.status === "checked") return { status: "checked", newItems: t.result.newItems, ...(t.result.error ? { error: t.result.error.slice(0, MAX_ERROR) } : {}) };
  // Past the checks above, the scheduler only refuses for its own reasons — a full run slot (or
  // a worker taking the last todo in between), so "busy" covers it.
  return t.status === "started" ? { status: "started" } : { status: "refused", reason: "busy" };
}

const UNREACHABLE = "Bean's desktop app isn't reachable";

const REFUSAL_TEXT: Record<RoutineTriggerRefusal, (name: string) => string> = {
  missing: (name) => `there's no sprout named "${name}" anymore — it was renamed or deleted`,
  changed: (name) => `${name} changed since this card — ask me again`,
  off: (name) => `${name} is off — say \`enable ${name}\` first`,
  review: (name) => `${name} needs its first review in Bean's Sprouts panel`,
  empty: (name) => `${name}'s queue is empty — queue a todo first`,
  busy: (name) => `${name} is already running`,
  unavailable: () => UNREACHABLE,
};

/** The bot's IPC slot to the app that spawned it (`process` in a real bot). */
export interface ParentPort {
  /** False for a standalone bot, or once the app has gone. */
  connected(): boolean;
  send(msg: RoutineTrigger, cb: (err: Error | null) => void): void;
  onMessage(cb: (raw: unknown) => void): void;
  onDisconnect(cb: () => void): void;
}

export const processParentPort: ParentPort = {
  connected: () => Boolean(process.send && process.connected),
  // The callback form: a closed channel must not surface as a process 'error' that kills the bot.
  send: (m, cb) => { process.send?.(m, undefined, {}, cb); },
  onMessage: (cb) => { process.on("message", cb); },
  onDisconnect: (cb) => { process.on("disconnect", cb); },
};

/** How long a bot waits for the app's answer — admission, or a check's poll (fetch/command,
 * each capped well under this). Only a wedged app ever hits it. */
export const ROUTINE_TRIGGER_TIMEOUT_MS = 120_000;

/** Bot side: `routines.sprouts.trigger` for an app-spawned bot. A reply settles only a request
 * this bot issued and is still waiting on; the app going away (or never answering) settles every
 * waiting tap as unreachable. No automatic resend — a lost answer may still have started the run. */
export function parentSproutTrigger(port: ParentPort = processParentPort, timeoutMs = ROUTINE_TRIGGER_TIMEOUT_MS, newId: () => string = randomUUID): SproutTriggerClient {
  // Waiting taps by request id; each settles with the app's answer or a fixed unreachable line.
  const pending = new Map<string, (a: RoutineTriggerAnswer | string) => void>();
  port.onMessage((raw) => {
    const r = parseRoutineTriggerResult(raw);
    if (r) pending.get(r.requestId)?.(r);
  });
  port.onDisconnect(() => {
    for (const settle of [...pending.values()]) settle(UNREACHABLE);
  });
  return (name, action, origin) => {
    if (!port.connected()) return Promise.resolve({ status: "refused", reason: UNREACHABLE });
    const requestId = newId();
    return new Promise<SproutTriggerAnswer>((resolve) => {
      const timer = setTimeout(() => settle("Bean's desktop app didn't answer"), timeoutMs);
      const settle = (a: RoutineTriggerAnswer | string): void => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        resolve(typeof a === "string" ? { status: "refused", reason: a } : answerText(name, a));
      };
      pending.set(requestId, settle);
      try {
        port.send({ type: "routine-trigger", requestId, name, action, origin }, (err) => { if (err) settle(UNREACHABLE); });
      } catch {
        settle(UNREACHABLE);
      }
    });
  };
}

export type SproutTriggerClient = (name: string, action: "run" | "check", origin: { channel?: string }) => Promise<SproutTriggerAnswer>;

const answerText = (name: string, a: RoutineTriggerAnswer): SproutTriggerAnswer => {
  if (a.status === "started") return { status: "started" };
  if (a.status === "refused") return { status: "refused", reason: REFUSAL_TEXT[a.reason](name) };
  const result: WatchCheckResult = { newItems: a.newItems, ...(a.error ? { error: a.error } : {}) };
  return { status: "checked", result };
};
