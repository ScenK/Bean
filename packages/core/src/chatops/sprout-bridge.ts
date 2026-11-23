// Sprout trigger bridge (#637): a bot the desktop app spawned has no scheduler (the app owns it),
// so its sprout-run card asks the app over the bot's Node IPC slot. Beside desk.ts and in the same
// shape: a request/answer pair, each side's parser rebuilding the message from known fields.
// Bot → app carries a sprout name, the action frozen on the card, the asking conversation's id and
// the tapper's id — never message text. A todo card's Run now (#923) carries the job id of the
// todo + dispatch the bot queued, never the task text. App → bot carries a status, a fixed refusal code, or a check's count.
import { randomUUID } from "node:crypto";
import type { Routine } from "../routine-store.js";
import type { TriggerResult, WatchCheckResult } from "../routine-scheduler.js";
import { planSproutRun, type HomeDms, type SproutOrigin, type SproutTrigger } from "../sprout-trigger.js";
import { configFile, loadConfig } from "../config.js";
import { getDispatch } from "../dispatch-store.js";
import { listTodos } from "../todo-store.js";
import { isWatchSeeded } from "../watch-store.js";
import { watchSourceKey } from "../watch.js";

/** What a bot's card tap gets back: TriggerResult minus the run's `done` (which stays with the
 * scheduler host — it posts the finish reply itself). */
export type SproutTriggerAnswer = { status: "started" } | Exclude<TriggerResult, { status: "started" }>;
/** A bot's sprout action: run/check a sprout, or `todo` = Run now for the todo queued as `job`. */
export type SproutAction = "run" | "check" | "todo";

/** Why the app refused a bridged trigger. A fixed set: the bot words each itself. */
export const ROUTINE_TRIGGER_REFUSALS = ["missing", "changed", "off", "review", "empty", "busy", "unavailable", "standby"] as const;
export type RoutineTriggerRefusal = (typeof ROUTINE_TRIGGER_REFUSALS)[number];

export type RoutineTrigger = {
  type: "routine-trigger"; requestId: string; name: string; action: SproutAction; origin: SproutOrigin;
  /** `todo` only: the dispatch id `queueTodoDispatch` returned. */
  job?: string;
};
export type RoutineTriggerAnswer =
  | { status: "started" }
  | { status: "next" }
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
  if (!o || !id(o.requestId) || !id(o.name) || (o.action !== "run" && o.action !== "check" && o.action !== "todo")) return undefined;
  if (o.action === "todo" ? !id(o.job) : o.job !== undefined) return undefined;
  if (typeof o.origin !== "object" || o.origin === null) return undefined;
  const { channel, actor } = o.origin as Record<string, unknown>;
  if ((channel !== undefined && !id(channel)) || (actor !== undefined && !id(actor))) return undefined;
  return {
    type: "routine-trigger", requestId: o.requestId, name: o.name, action: o.action,
    origin: { ...(channel !== undefined ? { channel } : {}), ...(actor !== undefined ? { actor } : {}) },
    ...(typeof o.job === "string" ? { job: o.job } : {}),
  };
}

/** App → bot, validated in the bot. */
export function parseRoutineTriggerResult(v: unknown): RoutineTriggerResult | undefined {
  const o = fields(v, "routine-trigger-result");
  if (!o || !id(o.requestId)) return undefined;
  const base = { type: "routine-trigger-result" as const, requestId: o.requestId };
  if (o.status === "started" || o.status === "next") return { ...base, status: o.status };
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

/** Bot side: the per-bot Home DM settings for the run card's wording (#1069), read live from
 * config.json (the app's Settings writes them); unreadable = none named. */
export const readHomeDms = (dir: string): Promise<HomeDms | undefined> =>
  loadConfig(configFile(dir), dir).then((c) => ({ discord: c.homeDiscordDm, teams: c.homeTeamsDm }), () => undefined);

/** App side: answers a bot's trigger. The card was planned in the bot, so the name is re-resolved
 * here (renamed or deleted = `missing`) and the frozen action re-planned: a sprout whose plan
 * changed since the card (now paused, emptied, or run ↔ check) is refused, never run as
 * something the owner didn't confirm. `trigger` is the scheduler's, dispatch record included.
 * `held` = this host holds the scheduler lease: a standby host refuses a run (`standby`), since
 * the holder's start would close its dispatch as interrupted. */
export async function answerRoutineTrigger(req: RoutineTrigger, deps: {
  load: () => Promise<Routine[]>;
  facts: (r: Routine) => Promise<{ pending: number; seeded: boolean }>;
  trigger: SproutTrigger;
  held: () => boolean;
} & TodoRunDeps): Promise<RoutineTriggerAnswer> {
  if (req.action === "todo") return answerTodoRun(req.job ?? "", deps);
  const routine = (await deps.load()).find((r) => r.name === req.name);
  if (!routine) return { status: "refused", reason: "missing" };
  const { pending, seeded } = await deps.facts(routine);
  const out = planSproutRun(routine, pending, seeded);
  if ("blocked" in out) return { status: "refused", reason: out.blocked };
  if (out.plan.action !== req.action) return { status: "refused", reason: "changed" };
  if (req.action === "run" && !deps.held()) return { status: "refused", reason: "standby" };
  const t = await deps.trigger(routine.name, req.action, req.origin);
  if (t.status === "checked") return { status: "checked", newItems: t.result.newItems, ...(t.result.error ? { error: t.result.error.slice(0, MAX_ERROR) } : {}) };
  // Past the checks above, the scheduler only refuses for its own reasons — a full run slot (or
  // a worker taking the last todo in between), so "busy" covers it.
  return t.status === "started" ? { status: "started" } : { status: "refused", reason: "busy" };
}

export interface TodoRunDeps {
  /** bean.db, where the job's dispatch row names its todo. */
  file: string;
  held: () => boolean;
  /** The scheduler's exact-todo Run now (`scheduler.runTodo`). */
  runTodo: (name: string, todoId: string) => Promise<TriggerResult>;
}

/** Scheduler host: Run now for a todo queued with its dispatch (`queueTodoDispatch`, #923). The job
 * id names both, so no task text crosses. A todo no longer pending was taken by a drain already
 * (`started`); a standby host leaves it queued (`standby`). */
export async function answerTodoRun(job: string, deps: TodoRunDeps): Promise<RoutineTriggerAnswer> {
  const d = getDispatch(deps.file, job);
  if (!d?.todoId) return { status: "refused", reason: "missing" };
  if (d.status !== undefined) return { status: "started" };
  if (!deps.held()) return { status: "refused", reason: "standby" };
  const t = await deps.runTodo(d.routine, d.todoId);
  // The scheduler refuses only a sprout that no longer takes tasks (deleted, or edited).
  return t.status === "started" || t.status === "next" ? { status: t.status } : { status: "refused", reason: "changed" };
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
  standby: () => "sprouts are paused on this Bean — another Bean process runs them for this data directory",
};

/** Bot → app (#924): which sprouts have a run going now — background_work's live counts. Carries
 * nothing but its request id. App → bot: names and slot counts, or none (`running` absent) when the
 * app isn't the scheduler host. */
export type RoutineRunning = { type: "routine-running"; requestId: string };
export type RoutineRunningResult = { type: "routine-running-result"; requestId: string; running?: { name: string; runs: number }[] };
const MAX_RUNNING = 200;

export function parseRoutineRunning(v: unknown): RoutineRunning | undefined {
  const o = fields(v, "routine-running");
  return o && id(o.requestId) ? { type: "routine-running", requestId: o.requestId } : undefined;
}

export function parseRoutineRunningResult(v: unknown): RoutineRunningResult | undefined {
  const o = fields(v, "routine-running-result");
  if (!o || !id(o.requestId)) return undefined;
  const base = { type: "routine-running-result" as const, requestId: o.requestId };
  if (o.running === undefined) return base;
  if (!Array.isArray(o.running) || o.running.length > MAX_RUNNING) return undefined;
  const running: { name: string; runs: number }[] = [];
  for (const r of o.running as unknown[]) {
    const e = r as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || !id(e.name) || !Number.isSafeInteger(e.runs) || (e.runs as number) < 0) return undefined;
    running.push({ name: e.name, runs: e.runs as number });
  }
  return { ...base, running };
}

/** How long background_work waits for the app's live counts before reporting them unknown. */
export const ROUTINE_RUNNING_TIMEOUT_MS = 5_000;

/** Bot side: the app's live run counts, or undefined (standalone bot, app gone, no answer, standby). */
export function parentSproutRunning(port: ParentPort = processParentPort, timeoutMs = ROUTINE_RUNNING_TIMEOUT_MS, newId: () => string = randomUUID):
  () => Promise<{ name: string; runs: number }[] | undefined> {
  const pending = new Map<string, (r: { name: string; runs: number }[] | undefined) => void>();
  port.onMessage((raw) => {
    const r = parseRoutineRunningResult(raw);
    if (r) pending.get(r.requestId)?.(r.running);
  });
  port.onDisconnect(() => { for (const settle of [...pending.values()]) settle(undefined); });
  return () => {
    if (!port.connected()) return Promise.resolve(undefined);
    const requestId = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      const settle = (r: { name: string; runs: number }[] | undefined): void => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        resolve(r);
      };
      pending.set(requestId, settle);
      try {
        port.send({ type: "routine-running", requestId }, (err) => { if (err) settle(undefined); });
      } catch {
        settle(undefined);
      }
    });
  };
}

/** The bot's IPC slot to the app that spawned it (`process` in a real bot). */
export interface ParentPort {
  /** False for a standalone bot, or once the app has gone. */
  connected(): boolean;
  send(msg: RoutineTrigger | RoutineRunning, cb: (err: Error | null) => void): void;
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
  return (name, action, origin, job) => {
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
        port.send({ type: "routine-trigger", requestId, name, action, origin, ...(job !== undefined ? { job } : {}) }, (err) => { if (err) settle(UNREACHABLE); });
      } catch {
        settle(UNREACHABLE);
      }
    });
  };
}

/** `job` = the `todo` action's queued todo + dispatch. */
export type SproutTriggerClient = (name: string, action: SproutAction, origin: SproutOrigin, job?: string) => Promise<SproutTriggerAnswer>;

const answerText = (name: string, a: RoutineTriggerAnswer): SproutTriggerAnswer => {
  if (a.status === "started" || a.status === "next") return { status: a.status };
  if (a.status === "refused") return { status: "refused", reason: REFUSAL_TEXT[a.reason](name) };
  const result: WatchCheckResult = { newItems: a.newItems, ...(a.error ? { error: a.error } : {}) };
  return { status: "checked", result };
};
