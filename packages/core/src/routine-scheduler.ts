// packages/core/src/routine-scheduler.ts
import { nextRun } from "./cron.js";
import { appendRunRecord, hasEnded, isArchived, isExpired, parallelSlots, untilLabel, untilTime, watchEveryMinutes } from "./routine-store.js";
import type { Routine, RoutineState, RoutineWatch, RunRecord, RunStatus } from "./routine-store.js";
import { takesAnswers } from "./sprout-answers.js";
import { DONE_FOOTER, type RoutineRunResult } from "./routine-runner.js";
import type { TodoItem } from "./todo-store.js";
import { watchDigest, watchSourceKey, watchTodoText } from "./watch.js";
import type { WatchItem } from "./watch.js";
import { inWatchWindow } from "./watch-window.js";

/** The seen-set for watch routines (bean.db in the app; a Map in tests). */
export interface WatchSeenDeps {
  isSeeded: (routine: string, source: string) => boolean;
  seed: (routine: string, source: string, ids: string[]) => void;
  /** Read-only: ids not seen yet. */
  unseen: (routine: string, ids: string[]) => string[];
  /** Records ids as seen; returns the ones that weren't. */
  markNew: (routine: string, ids: string[]) => string[];
}

export interface RoutineSchedulerDeps {
  loadRoutines: () => Promise<Routine[]>;
  loadStates: () => Promise<Record<string, RoutineState>>;
  saveStates: (states: Record<string, RoutineState>) => Promise<void>;
  /** `todo` set = a maxParallel worker's run of that one (already claimed) todo. `signal` =
   * the run's Stop (`stopRuns`). `claim` = how a draining run claims each todo (admitted in the
   * sprout's lane); absent = the host claims directly. */
  runRoutine: (routine: Routine, todo?: TodoItem, signal?: AbortSignal, claim?: (routine: string) => Promise<TodoItem | undefined>) => Promise<RoutineRunResult>;
  /** `brief` = the trigger asked for the run's brief: resolve with the chat sinks' body even when
   * the sprout has no chat sink. `origin` = the chat conversation that started this run, which
   * gets the result itself (#920). */
  deliverDigest: (routine: Routine, result: RoutineRunResult, brief?: boolean, origin?: RunOrigin) => Promise<string | void>;
  /** Chat sinks that can't be delivered (an unknown destination name): the run is recorded
   * needs-attention with these lines appended, before the record is saved. Absent = none. */
  sinkProblems?: (routine: Routine) => string[];
  /** Drops the routine's step attempts whose run isn't in `keepRunIds` (evicted or interrupted). */
  pruneAttempts?: (routine: string, keepRunIds: string[]) => void;
  now?: () => Date;
  /** Todo-driven gate: false = skip this fire (advance lastRun, record nothing). Absent = never skip. */
  hasPendingTodos?: (routine: string) => Promise<boolean>;
  /** Atomic pending → running for maxParallel workers. Absent = every routine runs one at a time. */
  claimTodo?: (routine: string) => Promise<TodoItem | undefined>;
  /** Run now (#923): this one todo pending → running; undefined = a drain took it (or it's gone).
   * Absent = no exact-todo runs. */
  claimTodoById?: (id: string) => Promise<TodoItem | undefined>;
  /** Watch triggers (all optional — absent = watch routines never poll). */
  pollWatch?: (watch: RoutineWatch) => Promise<WatchItem[]>;
  watchSeen?: WatchSeenDeps;
  addTodo?: (routine: string, text: string) => Promise<void>;
  saveRoutine?: (routine: Routine) => Promise<void>;
  /** A sprout that ended (`done` / expiry): drop its pending todos. Absent = they stay queued. */
  dropPendingTodos?: (routine: string) => Promise<void>;
  /** Fired once when a watch fails ALARM_AFTER polls in a row (desktop notification only —
   * never chatops sinks). Best-effort: the panel's status line is the guarantee. */
  alarm?: (routine: Routine, error: string) => void;
  /** Automatic fires gate: false = tick() does nothing (a host standing by for the scheduler
   * lease — a manual run's follow-up tick or Check now must not fire due routines). Absent = always. */
  canSchedule?: () => boolean;
  /** Fired once at start() with every routine just flagged missed (headless hosts DM the owner). */
  onMissed?: (names: string[]) => void;
}

export interface WatchCheckResult { newItems: number; error?: string }

/** The chat conversation a triggered run was started from (`channel` absent = the owner's DM). */
export interface RunOrigin { transport: "discord" | "teams"; channel?: string }

/** A triggered run's asks: `brief` = each outcome carries its run's brief; `origin` = where the
 * result goes back to, so a chat sink resolving there is skipped (#920). */
export interface RunOpts { brief?: boolean; origin?: RunOrigin }

/** One admitted run. `id` = its RunRecord id (absent when it threw before a record existed).
 * `brief` = the chat sinks' body for this run alone, capped at RUN_BRIEF_MAX — only when the
 * trigger asked for it, and never for a stopped run (it goes to no sink). */
export interface RunOutcome { id?: string; status: RunStatus; brief?: string }

/** Everything one trigger admitted, once all of it has finished: worst status wins
 * (failed > needs-attention > ok). `runs` 0 = every admitted worker found the queue empty.
 * `perRun` = each run on its own, in start order. */
export interface TriggerOutcome { status: RunStatus; runs: number; ok: number; needsAttention: number; failed: number; perRun: RunOutcome[] }

export type TriggerResult =
  | { status: "started"; done: Promise<TriggerOutcome> }
  /** Run now with every slot busy (#923): the todo waits at the front of the queue and runs next. */
  | { status: "next" }
  | { status: "refused"; reason: string }
  | { status: "checked"; result: WatchCheckResult };

/** A run's brief bound: a chat-sized answer, not the full report (that stays in the record). */
export const RUN_BRIEF_MAX = 4_000;

/** Folds per-run outcomes into one. */
export function triggerOutcome(perRun: RunOutcome[]): TriggerOutcome {
  const statuses = perRun.map((r) => r.status);
  const n = (st: RunStatus): number => statuses.filter((x) => x === st).length;
  const failed = n("failed");
  const needsAttention = n("needs-attention");
  return {
    status: failed > 0 ? "failed" : needsAttention > 0 ? "needs-attention" : "ok",
    runs: statuses.length, ok: n("ok"), needsAttention, failed, perRun,
  };
}

/** Appends undeliverable-sink lines to a run and raises an ok run to needs-attention. */
export function withSinkProblems(result: RoutineRunResult, problems: string[]): RoutineRunResult {
  // A quiet run delivers nothing, so an undeliverable sink changes nothing about it.
  if (problems.length === 0 || result.record.quiet !== undefined) return result;
  const digest = `${result.digest}\n\n${problems.map((p) => `⚠ ${p}`).join("\n")}`;
  const status: RunStatus = result.record.status === "ok" ? "needs-attention" : result.record.status;
  return { ...result, digest, record: { ...result.record, digest, status } };
}

/** What one admission's runs ended with: one outcome per run, and whether a Stop cut one short. */
interface FillResult { runs: RunOutcome[]; stopped: boolean }

/** Delivers an unstopped run and, when asked, keeps its capped brief on `run`. */
async function deliver(deps: RoutineSchedulerDeps, routine: Routine, result: RoutineRunResult, run: RunOutcome, opts: RunOpts): Promise<void> {
  const body = await deps.deliverDigest(routine, result, opts.brief ?? false, ...(opts.origin ? [opts.origin] : []));
  if (opts.brief && typeof body === "string") run.brief = body.length > RUN_BRIEF_MAX ? `${body.slice(0, RUN_BRIEF_MAX - 1)}…` : body;
}

const outcomeOf = (result: RoutineRunResult): RunOutcome =>
  ({ ...(result.record.id ? { id: result.record.id } : {}), status: result.record.status });

/** A done result that doesn't end the sprout (it lost to a sibling, or a restore happened since it
 * was admitted): delivered as an ordinary run — no "keep watching?" line, no ending flag. */
function asOrdinary(result: RoutineRunResult): RoutineRunResult {
  if (!result.ending) return result;
  const line = `\n\n${DONE_FOOTER}`;
  const { ending: _, ...rest } = result;
  const { done: __, ...record } = result.record;
  return {
    ...rest, digest: result.digest.replace(line, ""), record: { ...record, digest: record.digest.replace(line, "") },
    ...(result.footer ? { footer: result.footer.replace(line, "") } : {}),
  };
}

const TICK_MS = 30_000;
export const ALARM_AFTER = 3;

/** Due = the routine's next fire time after its schedule base has passed. The base is
 * lastRun when set, else the scheduler's start time — so a freshly saved routine waits
 * for its first real fire time instead of firing immediately, and schedules missed while
 * Bean was closed are marked missed (never auto-run: no catch-up by design). */
export function createRoutineScheduler(deps: RoutineSchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  // Live runs per routine: 1 for a single run, up to maxParallel for todo workers.
  const running = new Map<string, number>();
  const count = (name: string): number => running.get(name) ?? 0;
  // Routines a tick is deciding on — isRunning() reports them so the panel doesn't flicker idle
  // between "decided to run" and the run's own count.
  // Value = the deciding tick's token, so a tick only acts on / clears its own flags.
  const checking = new Map<string, symbol>();
  // Workers never prune inline (a sibling's run may be live or about to claim, its attempt rows
  // not saved yet): each save leaves the newest kept ids here, and the last worker of the sprout
  // to exit prunes with them. Saves are serialized, so the last write is the newest history.
  const pendingKeep = new Map<string, string[]>();
  let stopped = false;
  // Automatic fires only while this host holds the scheduler lease (re-checked after awaits).
  const mayFire = (): boolean => deps.canSchedule?.() ?? true;
  // Per-run Stop handles, registered at admission (before stamp/claims) and dropped when that
  // run/worker settles. `stopRuns(name)` aborts them; `stop()` (shutdown) doesn't touch them.
  const stops = new Map<string, Set<AbortController>>();
  const admit = (name: string): AbortController => {
    const ctl = new AbortController();
    const set = stops.get(name) ?? new Set();
    set.add(ctl);
    stops.set(name, set);
    return ctl;
  };
  const settleStop = (name: string, ctl: AbortController): void => {
    const set = stops.get(name);
    set?.delete(ctl);
    if (set?.size === 0) stops.delete(name);
  };
  // In-memory mirror of which routines markMissed() flagged, checked by tick() instead of a
  // fresh loadStates() read: nextRun(cron, a stale lastRun) keeps landing on the same past
  // due time forever, so tick() needs to remember "already handled as missed" itself rather
  // than re-deriving it — a disk round-trip would also just re-observe the same stale due date.
  const missedNames = new Set<string>();
  // Run-now todos that found every slot busy (#923), per routine, newest last: a freed slot runs the
  // newest, matching the queue (each Run now goes in front of the last). A drain or worker usually takes it first (it's at the queue's front), and then its
  // exact claim just loses. In memory only — after a restart the queue's front order still holds.
  const waiting = new Map<string, string[]>();
  // One serial lane per sprout (#980): a keyed promise chain. Only short admission (re-read the
  // definition, check it, take the slot / claim the todo) and commit (re-read, check, write the
  // ending / hand off poll results) phases run in it — never a run, a poll's fetch, fill() or
  // anything else that takes the lane, or it deadlocks. Generation = `until`: captured with the
  // admitted definition, a mismatch at commit means a restore or another ending came in between.
  const lanes = new Map<string, Promise<unknown>>();
  function withSprout<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (lanes.get(name) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    lanes.set(name, tail);
    void tail.then(() => { if (lanes.get(name) === tail) lanes.delete(name); });
    return run;
  }
  const find = async (name: string): Promise<Routine | undefined> => (await deps.loadRoutines()).find((r) => r.name === name);
  /** Past its `until` (expired or ended): never fired automatically, and no poll hands off. By
   * hand it still runs until archived. */
  const ended = (r: Routine): boolean => hasEnded(r, now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const checkSinks = (routine: Routine, result: RoutineRunResult): RoutineRunResult =>
    withSinkProblems(result, deps.sinkProblems?.(routine) ?? []);

  const scheduleBase = (state: RoutineState | undefined): Date => {
    const last = state?.lastRun ? new Date(state.lastRun) : undefined;
    return last ?? startedAt;
  };

  // Every .state.json write goes through one chain: ticks overlap (a long run keeps one tick
  // awaiting while the next starts polling), so bare load→save pairs would drop each other's
  // fields. In-process only: the scheduler lease (scheduler-lease.ts) keeps it to one process.
  let stateChain: Promise<unknown> = Promise.resolve();
  const withStates = (fn: (all: Record<string, RoutineState>) => Record<string, RoutineState> | undefined): Promise<void> => {
    const run = stateChain.then(async () => {
      const next = fn(await deps.loadStates());
      if (next) await deps.saveStates(next);
    });
    stateChain = run.catch(() => {});
    return run;
  };
  const updateState = (name: string, fn: (s: RoutineState | undefined) => RoutineState): Promise<void> =>
    withStates((all) => ({ ...all, [name]: fn(all[name]) }));

  /** Saves the record, then drops step attempts of runs the history just evicted (and of
   * interrupted runs) — skipped while a run of this routine is live, its rows aren't saved yet
   * (a sibling parallel run; the last finisher prunes). */
  const appendAndPrune = async (name: string, record: RunRecord, live: () => boolean = () => false, worker = false): Promise<void> => {
    let keep: string[] = [];
    await updateState(name, (s) => {
      const next = appendRunRecord(s, record);
      keep = next.history.flatMap((r) => (r.id ? [r.id] : []));
      if (worker) pendingKeep.set(name, keep);
      return next;
    });
    if (worker || live()) return; // read after the save: a sibling may have started a run meanwhile
    prune(name, keep);
  };
  const prune = (name: string, keep: string[]): void => {
    try { deps.pruneAttempts?.(name, keep); } catch (err) { console.warn("bean: step attempt prune failed", err instanceof Error ? err.name : err); }
  };

  // Consecutive poll failures, in memory (resets on restart — the alarm is a nudge, not a log).
  const failures = new Map<string, number>();
  const polling = new Set<string>();

  /** Stamp lastRun at start so a crash mid-run doesn't refire the same slot forever. */
  const stamp = async (name: string): Promise<void> => {
    await updateState(name, (prior) => ({ ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined }));
    missedNames.delete(name); // clear in lockstep with the disk stamp above — an attempted
    // run (success or failure) counts as "handled," so a throw below can't leave tick() stuck
    // skipping this routine forever while disk already says not-missed.
  };

  /** One slot freed. After a real run a watch polls once right away (ignoring its window, like
   * checkNow), then ticks — work that arrived during the run starts without waiting. */
  const release = (routine: Routine, ran: boolean): void => {
    const left = count(routine.name) - 1;
    if (left > 0) running.set(routine.name, left);
    else running.delete(routine.name);
    const next = waiting.get(routine.name)?.pop();
    if (waiting.get(routine.name)?.length === 0) waiting.delete(routine.name);
    if (next !== undefined && !stopped && mayFire()) void runExact(routine, next); // settles its own errors
    if (!ran || !routine.watch || stopped || !mayFire()) return;
    // Against the current definition: a watch disabled mid-run must not run its check again.
    void deps.loadRoutines().then(async (all) => {
      const current = all.find((r) => r.name === routine.name);
      if (!current?.enabled || !current.watch || stopped || !mayFire()) return;
      await poll(current, true);
      if (!stopped) await tick();
    }).catch((err: unknown) => console.error(`bean: watch "${routine.name}" post-run check failed`, err));
  };

  /** The single run (maxParallel 1, plain routines): one runRoutine call drains the queue.
   * Resolves with the run's status (a throw before a record exists counts as failed). A stopped
   * run is recorded but goes to no sink and triggers no post-run watch poll. */
  async function execute(routine: Routine, ctl: AbortController, opts: RunOpts, grace: boolean): Promise<FillResult> {
    let run: RunOutcome = { status: "failed" };
    let stoppedRun = false;
    try {
      await stamp(routine.name);
      const result = checkSinks(routine, await deps.runRoutine(routine, undefined, ctl.signal, deps.claimTodo ? laneClaim(routine, deps.claimTodo, grace) : undefined));
      run = outcomeOf(result);
      stoppedRun = result.stopped === true;
      const save = (record: RunRecord): Promise<void> => appendAndPrune(routine.name, record);
      if (result.record.done && !stoppedRun) await settleDone(routine, result, run, opts, save);
      else {
        await save(result.record);
        if (!stoppedRun) await deliver(deps, routine, result, run, opts);
      }
    } catch (err) {
      console.error(`bean: routine "${routine.name}" run failed`, err);
    } finally {
      settleStop(routine.name, ctl);
      release(routine, !stoppedRun);
    }
    return { runs: [run], stopped: stoppedRun };
  }

  /** Run now (#923): one slot, taken synchronously, runs exactly this todo — never the rest of the
   * queue, and its end starts no post-run poll or drain. A lost claim (a drain took it) frees the
   * slot with no run. Undefined = no free slot (nothing taken). */
  function runExact(routine: Routine, todoId: string): Promise<FillResult> | undefined {
    const claimById = deps.claimTodoById;
    if (!claimById || refuseRun(routine)) return undefined;
    running.set(routine.name, count(routine.name) + 1);
    let claimed = false;
    const once = (): Promise<TodoItem | undefined> => (claimed ? Promise.resolve(undefined) : (claimed = true, claimById(todoId)));
    return worker(routine, once, admit(routine.name), {}, false, ended(routine));
  }

  /** A maxParallel worker: claim a todo, run it as its own run, repeat until nothing's pending.
   * `postRun` false = its end polls nothing (a Run-now run, #923).
   * A lost claim ends the worker with no bubble, record or digest. Resolves with one status per
   * claimed todo. */
  async function worker(routine: Routine, claim: (name: string) => Promise<TodoItem | undefined>, ctl: AbortController, opts: RunOpts, postRun: boolean, grace: boolean): Promise<FillResult> {
    const runs: RunOutcome[] = [];
    let stoppedRun = false;
    // A stopped worker claims nothing more; a todo whose claim was in flight at the Stop still
    // goes to runRoutine, which fails it unrun (its signal is already aborted).
    // Each claim is admitted in the sprout's lane against the current definition: once a sibling's
    // done ended the sprout or a restore came in (either changes `until`), or it's archived, it stops.
    const admitted = laneClaim(routine, claim, grace);
    const next = (): Promise<TodoItem | undefined> => (ctl.signal.aborted ? Promise.resolve(undefined) : admitted(routine.name));
    try {
      for (let todo = await next(); todo; todo = await next()) {
        const at = runs.push({ status: "failed" }) - 1; // replaced by the record's once the run returns
        try {
          const result = checkSinks(routine, await deps.runRoutine(routine, todo, ctl.signal));
          runs[at] = outcomeOf(result);
          if (result.stopped) stoppedRun = true;
          const save = (record: RunRecord): Promise<void> => appendAndPrune(routine.name, record, undefined, true);
          if (result.record.done && !result.stopped) await settleDone(routine, result, runs[at]!, opts, save);
          else {
            await save(result.record);
            if (!result.stopped) await deliver(deps, routine, result, runs[at]!, opts);
          }
        } catch (err) {
          console.error(`bean: routine "${routine.name}" todo run failed`, err);
        }
      }
    } catch (err) {
      console.error(`bean: routine "${routine.name}" claim failed`, err);
    } finally {
      const keep = count(routine.name) === 1 ? pendingKeep.get(routine.name) : undefined; // the last worker out
      if (keep) { pendingKeep.delete(routine.name); prune(routine.name, keep); }
      settleStop(routine.name, ctl);
      release(routine, postRun && runs.length > 0 && !stoppedRun);
    }
    return { runs, stopped: stoppedRun };
  }

  /** Commits a run whose route reached `done` (#980), in the sprout's lane. It ends the sprout only
   * when the definition still carries the generation (`until`) it was admitted with and this host
   * holds the lease: deliver, then pause with `until` = the run's finish and drop the queue. A
   * sibling that got there first (its ending changed `until`) or a restore since → delivered as an
   * ordinary run — recorded without `done` or the footer. A failed hand-off: the run turns
   * needs-attention, the sprout is paused with its queue kept for the owner — no automatic
   * re-delivery. `save` records the run (after the election, so only the winner's says done). */
  async function settleDone(routine: Routine, result: RoutineRunResult, run: RunOutcome, opts: RunOpts, save: (record: RunRecord) => Promise<void>): Promise<void> {
    const name = routine.name;
    const won = await withSprout(name, async () => {
      const c = await find(name);
      if (!c || c.until !== routine.until || !mayFire()) return false;
      await save(result.record);
      try {
        await deliver(deps, routine, result, run, opts);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`bean: sprout "${name}" done delivery failed — paused`, err);
        run.status = "needs-attention";
        const key = result.record.id ?? result.record.startedAt;
        const line = `\n\n⚠ couldn't deliver this (${why.slice(0, 200)}) — paused with its queue kept`;
        await updateState(name, (s) => ({
          ...(s ?? { history: [] }),
          history: (s?.history ?? []).map((h) => ((h.id ?? h.startedAt) === key ? { ...h, status: "needs-attention" as const, digest: `${h.digest}${line}` } : h)),
        })).catch(() => {});
        await deps.saveRoutine?.({ ...c, enabled: false });
        return true;
      }
      await deps.saveRoutine?.({ ...c, enabled: false, until: result.record.finishedAt });
      await deps.dropPendingTodos?.(name);
      return true;
    });
    if (won) return;
    const ordinary = asOrdinary(result);
    await save(ordinary.record);
    await deliver(deps, routine, ordinary, run, opts);
  }

  /** A drain's claim, admitted in the sprout's lane against the current definition: it stops once
   * a sibling's done ended the sprout or a restore came in (either changes `until`), once it's
   * archived, and once its deadline passes — unless `grace`: the sprout had already ended when the
   * run was admitted (read synchronously at admission, before any await — only a run by hand gets
   * that, the tick never admits an ended sprout). */
  function laneClaim(routine: Routine, claim: (name: string) => Promise<TodoItem | undefined>, grace: boolean): (name: string) => Promise<TodoItem | undefined> {
    return (name) => withSprout(name, async () => {
      const c = await find(name);
      return c && !isArchived(c, now()) && c.until === routine.until && (grace || !ended(c)) ? claim(name) : undefined;
    });
  }

  /** Starts runs into the routine's free slots (maxParallel − live). The slots are taken
   * synchronously, before any await, so concurrent fills never overcommit. Resolves when the
   * started runs end, with one outcome per run they made. Each run/worker's Stop handle is
   * registered here, with its slot. */
  async function fill(routine: Routine, opts: RunOpts = {}): Promise<FillResult> {
    const slots = deps.claimTodo ? parallelSlots(routine) : 1;
    const free = slots - count(routine.name);
    if (free <= 0) return { runs: [], stopped: false };
    running.set(routine.name, count(routine.name) + free);
    const grace = ended(routine); // at admission, before any await (see laneClaim)
    if (slots === 1 || !deps.claimTodo) return execute(routine, admit(routine.name), opts, grace);
    const claim = deps.claimTodo;
    const ctls = Array.from({ length: free }, () => admit(routine.name));
    await stamp(routine.name).catch((err: unknown) => console.error(`bean: routine "${routine.name}" stamp failed`, err));
    const all = await Promise.all(ctls.map((ctl) => worker(routine, claim, ctl, opts, true, grace)));
    return { runs: all.flatMap((r) => r.runs), stopped: all.some((r) => r.stopped) };
  }

  /** Why a run can't start now (the same reasons Run now gives), or undefined. Synchronous, so a
   * caller can fill() right after with no await in between. */
  const refuseRun = (routine: Routine): string | undefined => {
    if (isArchived(routine, now())) return "it's archived — restore it first";
    if (routine.watch && routine.steps.length === 0) return "a notify-only watch has no steps to run — use Check now";
    const slots = deps.claimTodo ? parallelSlots(routine) : 1;
    const live = count(routine.name);
    if (live >= slots) return slots > 1 ? `${live}/${slots} running` : "already running";
    return undefined;
  };
  const noSuch = (name: string): string => `no sprout named "${name}"`;

  const pollDue = (routine: Routine & { watch: RoutineWatch }, state: RoutineState | undefined, at: Date): boolean =>
    !state?.lastPoll || new Date(state.lastPoll).getTime() + watchEveryMinutes(routine.watch) * 60_000 <= at.getTime();

  /** New items on a notify-only watch: the digest is built here (no model, no runRoutine) and
   * one RunRecord is written per fire, so the Dashboard and run list show it. */
  /** False = `lost()` turned true before delivery started (lease gone): nothing was delivered. */
  async function fireNotify(routine: Routine, items: WatchItem[], at: string, lost: () => boolean): Promise<boolean> {
    const digest = watchDigest(items);
    const fired = checkSinks(routine, {
      digest, results: [], record: { startedAt: at, finishedAt: now().toISOString(), status: "ok", digest, steps: [] },
    });
    await appendAndPrune(routine.name, fired.record, () => count(routine.name) > 0);
    // ponytail: a lease lost during the history save leaves that one record undelivered; the new
    // holder re-offers the items (not marked seen). Delivery itself, once started, can't be recalled.
    if (lost()) return false;
    await deps.deliverDigest(routine, fired);
    return true;
  }

  /** One poll: seed on first sight (fires nothing), otherwise diff against the seen-set.
   * Todo-driven watches only queue — the queue is the due signal tick() drains. */
  /** `auto` = a scheduled/post-run poll: a lease lost mid-poll drops its results with no side
   * effects (nothing marked seen, so the new holder's next poll re-offers them). Check now isn't. */
  async function poll(routine: Routine, auto = false): Promise<WatchCheckResult> {
    const watch = routine.watch;
    const lost = (): boolean => auto && !mayFire();
    if (!watch || !deps.pollWatch || !deps.watchSeen) return { newItems: 0, error: "watch polling isn't available" };
    if (polling.has(routine.name)) return { newItems: 0, error: "already checking" };
    const at = now().toISOString();
    // A failed check OR a failed hand-off (todo insert, digest delivery) is one failure: it
    // shows on the status line and counts toward the alarm, and nothing gets marked seen.
    const fail = async (err: unknown): Promise<WatchCheckResult> => {
      const error = err instanceof Error ? err.message : String(err);
      if (lost()) return { newItems: 0, error };
      const count = (failures.get(routine.name) ?? 0) + 1;
      failures.set(routine.name, count);
      if (count === ALARM_AFTER) deps.alarm?.(routine, error);
      await updateState(routine.name, (s) => ({ ...(s ?? { history: [] }), lastPoll: at, pollError: error })).catch(() => {});
      return { newItems: 0, error };
    };
    polling.add(routine.name);
    try {
      let items: WatchItem[];
      try {
        items = await deps.pollWatch(watch);
      } catch (err) {
        return await fail(err);
      }
      // The hand-off is the poll's commit, in the sprout's lane against the current definition.
      return await withSprout(routine.name, () => handOff(items));
    } catch (err) {
      console.error(`bean: watch "${routine.name}" poll failed`, err);
      return await fail(err);
    } finally {
      polling.delete(routine.name);
    }

    async function handOff(items: WatchItem[]): Promise<WatchCheckResult> {
      if (!watch || !deps.watchSeen) return { newItems: 0 };
      // Edited while this poll was in flight: these results belong to the old source — drop
      // them rather than seeding/stamping the new one with them. Ended, or restored (`until`
      // changed) since the poll started: stale — dropped, nothing marked seen.
      const current = await find(routine.name);
      if (!current?.watch || watchSourceKey(current.watch) !== watchSourceKey(watch)) return { newItems: 0 };
      if (ended(current) || current.until !== routine.until) return { newItems: 0 };
      if (lost()) return { newItems: 0 };
      const unique = [...new Map(items.map((i) => [i.id, i])).values()];
      const ids = unique.map((i) => i.id);
      const source = watchSourceKey(watch);
      let fresh: WatchItem[] = [];
      if (!deps.watchSeen.isSeeded(routine.name, source)) {
        deps.watchSeen.seed(routine.name, source, ids);
      } else {
        const unseen = new Set(deps.watchSeen.unseen(routine.name, ids));
        fresh = unique.filter((i) => unseen.has(i.id));
        // At-least-once: an item is marked seen only after its todo/digest is handed off, so a
        // crash or failed insert re-offers it next poll instead of silently dropping it.
        if (fresh.length > 0 && routine.steps.length === 0) {
          if (!(await fireNotify(routine, fresh, at, lost))) return { newItems: 0 };
        } else {
          for (const item of fresh) {
            if (lost()) return { newItems: 0 }; // the rest stay unseen for the new holder
            await deps.addTodo?.(routine.name, watchTodoText(item));
            deps.watchSeen.markNew(routine.name, [item.id]);
          }
        }
        deps.watchSeen.markNew(routine.name, ids); // refresh seen_at for everything still there
      }
      failures.delete(routine.name);
      await updateState(routine.name, (s) => ({ ...(s ?? { history: [] }), lastPoll: at, pollError: undefined }));
      return { newItems: fresh.length };
    }
  }

  async function tick(): Promise<void> {
    if (!mayFire()) return;
    // Flag candidates right after the routines load (before the states await) so an isRunning()
    // check made while a tick is still in flight sees them.
    const routines = await deps.loadRoutines();
    // A running watch still polls (and may fill free slots); a running cron routine waits — its
    // own run/workers already drain the queue. Past its `until`: never polled or run again —
    // still on = expired, which ends it below once idle (#980).
    const candidates = routines.filter((r) => r.enabled && !ended(r) && !checking.has(r.name) && (count(r.name) === 0 || r.watch));
    const token = Symbol("tick");
    for (const routine of candidates) checking.set(routine.name, token);
    const unflag = (): void => { for (const r of candidates) if (checking.get(r.name) === token) checking.delete(r.name); };
    const due: Routine[] = [];
    try {
      const states = await deps.loadStates();
      const nowT = now();
      // Runs start only after every poll in this pass, so one long run can't stall other watches.
      for (const routine of candidates) {
        try {
          await consider(routine, states[routine.name], nowT);
        } catch (err) {
          // A transient failure (e.g. a SQLite lock in hasPendingTodos) skips this routine this tick.
          console.error(`bean: routine "${routine.name}" due check failed`, err);
        }
      }
      for (const r of routines) {
        if (isExpired(r, now())) await expire(r).catch((err: unknown) => console.error(`bean: sprout "${r.name}" expiry failed`, err));
      }
    } catch (err) {
      unflag();
      throw err;
    }
    // Due routines start together, each admitted in its lane against its current definition (fill
    // takes its slots synchronously, right as the flag clears). One a Run now started while this
    // tick was deciding (it dropped the flag) is already handled. A lease lost mid-tick admits nothing.
    const go = mayFire() ? due.filter((r) => checking.get(r.name) === token) : [];
    for (const r of candidates) if (!go.includes(r) && checking.get(r.name) === token) checking.delete(r.name);
    let started: ({ ran: Promise<FillResult> } | undefined)[];
    try {
      started = await Promise.all(go.map((r) => withSprout(r.name, async () => {
        const c = await find(r.name);
        if (checking.get(r.name) !== token) return undefined;
        checking.delete(r.name);
        return c?.enabled && !ended(c) && mayFire() ? { ran: fill(c) } : undefined;
      })));
    } finally {
      unflag();
    }
    await Promise.all(started.map((s) => s?.ran));

    async function consider(routine: Routine, state: RoutineState | undefined, nowT: Date): Promise<void> {
      if (!mayFire()) return; // earlier polls this pass may be slow
      if (routine.watch) {
        // No cron, no missed-marking: a watch is due when its queue has work. The window gates
        // scheduled polls only (read against now(), since earlier polls this pass may be slow);
        // a skipped poll leaves lastPoll/failures alone, and draining is never gated.
        if (pollDue({ ...routine, watch: routine.watch }, state, nowT) && inWatchWindow(routine.watch.window, now())) await poll(routine, true);
        const hasWork = routine.steps.length > 0 && routine.todoDriven && deps.hasPendingTodos
          ? await deps.hasPendingTodos(routine.name) : false;
        if (hasWork) due.push(routine);
        return;
      }
      // A missed schedule stays missed until someone actually runs it (stamp() clears the
      // flag) — no catch-up by design, otherwise nextRun(cron, stale lastRun) would keep
      // returning the same past due time and tick() would auto-run it on its very next pass.
      if (missedNames.has(routine.name)) return;
      let dueAt: Date;
      try {
        dueAt = nextRun(routine.cron ?? "", scheduleBase(state));
      } catch {
        return; // unparseable cron in a hand-edited file — skip, panel save validates
      }
      if (dueAt.getTime() > nowT.getTime()) return;
      if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) {
        // Empty queue: consume the slot without a run — otherwise this stale due time
        // refires every tick forever (same shape as the missed/no-catch-up rule).
        await updateState(routine.name, (prior) => ({ ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined }));
        return;
      }
      due.push(routine);
    }
  }

  /** Expiry (#980), the lease holder's tick, in the sprout's lane: post "Nothing by <date> —
   * extend?" to its sinks, then pause it and drop its queue. Waits until the sprout is idle (a live
   * run may still reach done). Post first: a crash in between posts again (at-least-once, like the
   * outbox); a failed post leaves it on, so the next tick tries again. No pause without
   * `saveRoutine` (it'd post every tick). */
  async function expire(routine: Routine): Promise<void> {
    if (!deps.saveRoutine) return;
    const save = deps.saveRoutine;
    await withSprout(routine.name, async () => {
      const c = await find(routine.name);
      if (!c || !isExpired(c, now()) || count(c.name) > 0 || !mayFire()) return;
      const at = now().toISOString();
      const digest = `Nothing by ${untilLabel(c.until)} — extend?`;
      await deps.deliverDigest(c, { digest, results: [], ending: "expired", record: { startedAt: at, finishedAt: at, status: "ok", digest, steps: [] } });
      await save({ ...c, enabled: false });
      await deps.dropPendingTodos?.(c.name);
    });
  }

  /** Flag routines whose fire time passed while Bean was closed (base = lastRun, fire < startedAt). */
  async function markMissed(): Promise<void> {
    const routines = await deps.loadRoutines();
    const flagged: string[] = [];
    const states = await deps.loadStates();
    for (const routine of routines) {
      const state = states[routine.name];
      if (!routine.enabled || !routine.cron || !state?.lastRun || state.missed) continue;
      try {
        if (nextRun(routine.cron, new Date(state.lastRun)).getTime() < startedAt.getTime()) {
          // A todo-driven routine's missed fire is only a real problem if there's still
          // pending work to catch up on — an empty queue means tick()'s own hasPendingTodos
          // gate would have silently skipped that fire anyway, so flagging it missed here
          // would be a false alarm the user can't act on (and it'd get stuck: missedNames
          // makes tick() skip re-checking due-ness until someone manually runs it).
          if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) continue;
          flagged.push(routine.name);
          missedNames.add(routine.name);
        }
      } catch { /* bad cron — ignore */ }
    }
    if (flagged.length === 0) return;
    await withStates((all) => {
      const next = { ...all };
      for (const name of flagged) next[name] = { ...(next[name] ?? { history: [] }), missed: true };
      return next;
    });
    deps.onMissed?.(flagged);
  }

  async function check(name: string, routine: Routine | undefined): Promise<WatchCheckResult> {
    if (!routine?.watch || isArchived(routine, now())) return { newItems: 0, error: `no watch sprout named "${name}"` };
    if (!routine.enabled) return { newItems: 0, error: "enable the sprout first" };
    if (ended(routine)) return { newItems: 0, error: `it ended ${untilLabel(routine.until)} — give it a later end date first` };
    const result = await poll(routine);
    if (result.newItems > 0 && routine.steps.length > 0) void tick();
    return result;
  }

  return {
    start(): void {
      void markMissed();
      timer = setInterval(() => void tick(), TICK_MS);
    },
    /** Stops the routine's live runs (a no-op when idle): each in-flight step is cancelled, its
     * todo failed, pending todos stay pending, and the next scheduled fire still runs. */
    stopRuns(name: string): void {
      for (const ctl of stops.get(name) ?? []) ctl.abort();
    },
    /** Shutdown — not a run's Stop (see stopRuns). */
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    /** The sprout's serial lane (#980) for the host's own admission/commit writes (save, restore,
     * todo retry). `fn` must not await anything that takes the lane (fill, enableWatch, a run). */
    withSprout,
    /** Hosts with no Run-now (headless): drop the missed flag and rebase the schedule to now, so
     * each routine fires at its next slot — the missed one is still never run. */
    /** A cron sprout restored after it ended (#980): its schedule restarts from now — the next slot
     * fires, a slot that passed while it was ended is not caught up, and a stale missed flag goes. */
    async rebase(name: string): Promise<void> {
      await updateState(name, (s) => ({ ...(s ?? { history: [] }), lastRun: now().toISOString(), missed: undefined }));
      missedNames.delete(name);
    },
    async clearMissed(names: string[]): Promise<void> {
      const at = startedAt.toISOString();
      await withStates((all) => {
        const next = { ...all };
        for (const name of names) next[name] = { ...(next[name] ?? { history: [] }), lastRun: at, missed: undefined };
        return next;
      });
      for (const name of names) missedNames.delete(name);
    },
    /** Resolves once every queued .state.json write has landed (shutdown: stop(), then await this). */
    settle: (): Promise<void> => stateChain.then(() => {}),
    isRunning: (name: string): boolean => count(name) > 0 || checking.has(name),
    /** Live runs of the routine (its taken slots) — the panel's "2/3 running". */
    runningCount: count,
    /** Routines with a taken slot — from the instant fill() admits a run, before its status bubble
     * exists (a core update's busy check, #837). */
    runningNames: (): string[] => [...running].filter(([, n]) => n > 0).map(([name]) => name),
    pollFailures: (name: string): number => failures.get(name) ?? 0,
    /** Refuses only when every slot is taken; otherwise fills the free ones and resolves once
     * they finish, with their worst status and each run's outcome (none when no run happened) and
     * whether one was stopped. `brief` = each outcome carries its run's brief. */
    async runNow(name: string, opts: { brief?: boolean } = {}): Promise<{ started: boolean; reason?: string; status?: RunStatus; runs?: RunOutcome[]; stopped?: true }> {
      const admitted = await withSprout(name, async () => {
        const routine = await find(name);
        if (!routine) return { reason: noSuch(name) };
        const reason = refuseRun(routine);
        if (reason) return { reason };
        checking.delete(name); // an in-flight tick's due decision for it is now stale
        return { run: fill(routine, opts) }; // no await between the check above and fill's synchronous slot grab
      });
      if (!admitted.run) return { started: false, reason: admitted.reason };
      const ran = await admitted.run; // outside the lane: the run's own commit takes it
      return {
        started: true,
        ...(ran.runs.length ? { status: triggerOutcome(ran.runs).status, runs: ran.runs } : {}),
        ...(ran.stopped ? { stopped: true as const } : {}),
      };
    },
    /** Poll a watch right now, ignoring its window (runNow doesn't poll). New todo-driven items
     * drain via a tick. */
    async checkNow(name: string): Promise<WatchCheckResult> {
      return check(name, (await deps.loadRoutines()).find((r) => r.name === name));
    },
    /** Run or check (pick with `sproutTriggerAction`), answering as soon as the run is admitted:
     * `done` resolves when every slot this call took has finished. A run also refuses a
     * todo-driven sprout whose queue is empty (runNow would start a no-op drain). */
    async trigger(name: string, action: "run" | "check", opts: RunOpts = {}): Promise<TriggerResult> {
      if (action === "check") {
        const routine = await find(name);
        if (!routine) return { status: "refused", reason: noSuch(name) };
        return { status: "checked", result: await check(name, routine) };
      }
      return withSprout(name, async (): Promise<TriggerResult> => {
        const routine = await find(name);
        if (!routine) return { status: "refused", reason: noSuch(name) };
        if (isArchived(routine, now())) return { status: "refused", reason: refuseRun(routine)! };
        if (routine.todoDriven && routine.steps.length > 0 && deps.hasPendingTodos && !(await deps.hasPendingTodos(name))) {
          return { status: "refused", reason: "queue's empty now" };
        }
        const reason = refuseRun(routine);
        if (reason) return { status: "refused", reason };
        checking.delete(name);
        return { status: "started", done: fill(routine, opts).then((r) => triggerOutcome(r.runs)) }; // fill takes its slots synchronously
      });
    },
    /** Run now for one queued todo (#923, `todoId` already at the queue's front): runs only it in a
     * free slot (`started`), or, every slot busy, leaves it first in line — the running drain or
     * worker takes it next, else the next freed slot runs it (`next`). Never stops a running task. */
    async runTodo(name: string, todoId: string): Promise<TriggerResult> {
      return withSprout(name, async (): Promise<TriggerResult> => {
        const routine = await find(name);
        if (!routine) return { status: "refused", reason: noSuch(name) };
        // An answer on a plain sprout (#1135): a normal run, which claims every pending answer.
        // Already running = `next`: the answer waits for the run after this one.
        if (!routine.todoDriven && takesAnswers(routine)) {
          const reason = refuseRun(routine);
          if (reason) return isArchived(routine, now()) ? { status: "refused", reason } : { status: "next" };
          checking.delete(name);
          return { status: "started", done: fill(routine).then((r) => triggerOutcome(r.runs)) };
        }
        if (!routine.todoDriven || routine.steps.length === 0 || !deps.claimTodoById) return { status: "refused", reason: `"${name}" doesn't take tasks` };
        // Not "next in line": an archived sprout has no slot coming for it.
        if (isArchived(routine, now())) return { status: "refused", reason: refuseRun(routine)! };
        const run = runExact(routine, todoId); // no await between the load above and the slot grab
        if (run) {
          checking.delete(name);
          return { status: "started", done: run.then((r) => triggerOutcome(r.runs)) };
        }
        waiting.set(name, [...(waiting.get(name) ?? []), todoId]);
        return { status: "next" };
      });
    },
    /** Enable from review: check the source again, seed from THAT check (not the build-time
     * preview), optionally queue what's already there, then save enabled. Also the restore path of
     * an ended watch (#980): `until` = its new end (`null` clears it) — refused while the end it
     * would run with has passed; items published while it was off aren't judged. The seed, the new
     * `until` and `enabled` are committed together in the lane, only after the check succeeded —
     * a failed check leaves it as it was. */
    async enableWatch(name: string, queueExisting: boolean, until?: string | null): Promise<{ count: number }> {
      const found = await find(name);
      if (!found?.watch) throw new Error(`no watch sprout named "${name}"`);
      const watch = found.watch;
      if (typeof until === "string" && untilTime(until) === undefined) throw new Error("until must be a date (YYYY-MM-DD) or an ISO date-time");
      const end = until === undefined ? found.until : until ?? undefined;
      if (hasEnded({ until: end }, now())) throw new Error(`its end date has passed — pick a later one to turn "${name}" back on`);
      if (!deps.pollWatch || !deps.watchSeen || !deps.saveRoutine) throw new Error("watch polling isn't available");
      const [seen, save] = [deps.watchSeen, deps.saveRoutine];
      if (polling.has(name)) throw new Error("already checking — try again in a moment");
      polling.add(name);
      try {
        const at = now().toISOString();
        const items = [...new Map((await deps.pollWatch(watch)).map((i) => [i.id, i])).values()];
        return await withSprout(name, async () => {
          const cur = await find(name);
          if (!cur?.watch || watchSourceKey(cur.watch) !== watchSourceKey(watch)) throw new Error(`"${name}" changed while I was checking — try again`);
          // Queue first, seed after: a crash or failed insert in between leaves the watch unseeded
          // (still "needs review"), so the opted-in items are re-offered rather than lost.
          if (queueExisting && cur.todoDriven && cur.steps.length > 0) {
            for (const item of items) await deps.addTodo?.(name, watchTodoText(item));
          }
          seen.seed(name, watchSourceKey(watch), items.map((i) => i.id));
          failures.delete(name);
          await updateState(name, (s) => ({ ...(s ?? { history: [] }), lastPoll: at, pollError: undefined }));
          const { until: _, ...rest } = cur;
          await save({ ...rest, ...(end !== undefined ? { until: end } : {}), enabled: true });
          return { count: items.length };
        });
      } finally {
        polling.delete(name);
      }
    },
  };
}
