// packages/core/src/routine-scheduler.ts
import { nextRun } from "./cron.js";
import { appendRunRecord, parallelSlots, watchEveryMinutes } from "./routine-store.js";
import type { Routine, RoutineState, RoutineWatch, RunRecord, RunStatus } from "./routine-store.js";
import type { RoutineRunResult } from "./routine-runner.js";
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
   * the run's Stop (`stopRuns`). */
  runRoutine: (routine: Routine, todo?: TodoItem, signal?: AbortSignal) => Promise<RoutineRunResult>;
  deliverDigest: (routine: Routine, result: RoutineRunResult) => Promise<void>;
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
  /** Watch triggers (all optional — absent = watch routines never poll). */
  pollWatch?: (watch: RoutineWatch) => Promise<WatchItem[]>;
  watchSeen?: WatchSeenDeps;
  addTodo?: (routine: string, text: string) => Promise<void>;
  saveRoutine?: (routine: Routine) => Promise<void>;
  /** Fired once when a watch fails ALARM_AFTER polls in a row (desktop notification only —
   * never chatops sinks). Best-effort: the panel's status line is the guarantee. */
  alarm?: (routine: Routine, error: string) => void;
  /** Fired once at start() with every routine just flagged missed (headless hosts DM the owner). */
  onMissed?: (names: string[]) => void;
}

export interface WatchCheckResult { newItems: number; error?: string }

/** Everything one trigger admitted, once all of it has finished: worst status wins
 * (failed > needs-attention > ok). `runs` 0 = every admitted worker found the queue empty. */
export interface TriggerOutcome { status: RunStatus; runs: number; ok: number; needsAttention: number; failed: number }

export type TriggerResult =
  | { status: "started"; done: Promise<TriggerOutcome> }
  | { status: "refused"; reason: string }
  | { status: "checked"; result: WatchCheckResult };

/** Folds per-run statuses into one outcome. */
export function triggerOutcome(statuses: RunStatus[]): TriggerOutcome {
  const n = (st: RunStatus): number => statuses.filter((x) => x === st).length;
  const failed = n("failed");
  const needsAttention = n("needs-attention");
  return {
    status: failed > 0 ? "failed" : needsAttention > 0 ? "needs-attention" : "ok",
    runs: statuses.length, ok: n("ok"), needsAttention, failed,
  };
}

/** Appends undeliverable-sink lines to a run and raises an ok run to needs-attention. */
export function withSinkProblems(result: RoutineRunResult, problems: string[]): RoutineRunResult {
  if (problems.length === 0) return result;
  const digest = `${result.digest}\n\n${problems.map((p) => `⚠ ${p}`).join("\n")}`;
  const status: RunStatus = result.record.status === "ok" ? "needs-attention" : result.record.status;
  return { ...result, digest, record: { ...result.record, digest, status } };
}

/** What one admission's runs ended with: a status per run, and whether a Stop cut one short. */
interface FillResult { statuses: RunStatus[]; stopped: boolean }

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
  // Worker runs whose record isn't saved yet (running, or finished and saving) — a run prunes
  // only when it's the last one, else it could drop a sibling's attempt rows. Checked after the
  // save and dropped right after it; saves are serialized, so the last saver always prunes.
  const inFlight = new Map<string, number>();
  const bump = (name: string, by: number): void => { inFlight.set(name, (inFlight.get(name) ?? 0) + by); };
  let stopped = false;
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
  let timer: ReturnType<typeof setInterval> | undefined;
  const checkSinks = (routine: Routine, result: RoutineRunResult): RoutineRunResult =>
    withSinkProblems(result, deps.sinkProblems?.(routine) ?? []);

  const scheduleBase = (state: RoutineState | undefined): Date => {
    const last = state?.lastRun ? new Date(state.lastRun) : undefined;
    return last ?? startedAt;
  };

  // Every .state.json write goes through one chain: ticks overlap (a long run keeps one tick
  // awaiting while the next starts polling), so bare load→save pairs would drop each other's
  // fields. ponytail: in-process only — the bots never write .state.json.
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
  const appendAndPrune = async (name: string, record: RunRecord, live: () => boolean = () => false): Promise<void> => {
    let keep: string[] = [];
    await updateState(name, (s) => {
      const next = appendRunRecord(s, record);
      keep = next.history.flatMap((r) => (r.id ? [r.id] : []));
      return next;
    });
    if (live()) return; // read after the save: a sibling may have started a run meanwhile
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
    if (!ran || !routine.watch || stopped) return;
    // Against the current definition: a watch disabled mid-run must not run its check again.
    void deps.loadRoutines().then(async (all) => {
      const current = all.find((r) => r.name === routine.name);
      if (!current?.enabled || !current.watch || stopped) return;
      await poll(current);
      if (!stopped) await tick();
    }).catch((err: unknown) => console.error(`bean: watch "${routine.name}" post-run check failed`, err));
  };

  /** The single run (maxParallel 1, plain routines): one runRoutine call drains the queue.
   * Resolves with the run's status (a throw before a record exists counts as failed). A stopped
   * run is recorded but goes to no sink and triggers no post-run watch poll. */
  async function execute(routine: Routine, ctl: AbortController): Promise<FillResult> {
    let status: RunStatus = "failed";
    let stoppedRun = false;
    try {
      await stamp(routine.name);
      const result = checkSinks(routine, await deps.runRoutine(routine, undefined, ctl.signal));
      status = result.record.status;
      stoppedRun = result.stopped === true;
      await appendAndPrune(routine.name, result.record);
      if (!stoppedRun) await deps.deliverDigest(routine, result);
    } catch (err) {
      console.error(`bean: routine "${routine.name}" run failed`, err);
    } finally {
      settleStop(routine.name, ctl);
      release(routine, !stoppedRun);
    }
    return { statuses: [status], stopped: stoppedRun };
  }

  /** A maxParallel worker: claim a todo, run it as its own run, repeat until nothing's pending.
   * A lost claim ends the worker with no bubble, record or digest. Resolves with one status per
   * claimed todo. */
  async function worker(routine: Routine, claim: (name: string) => Promise<TodoItem | undefined>, ctl: AbortController): Promise<FillResult> {
    const statuses: RunStatus[] = [];
    let stoppedRun = false;
    // A stopped worker claims nothing more; a todo whose claim was in flight at the Stop still
    // goes to runRoutine, which fails it unrun (its signal is already aborted).
    const next = (): Promise<TodoItem | undefined> => (ctl.signal.aborted ? Promise.resolve(undefined) : claim(routine.name));
    try {
      for (let todo = await next(); todo; todo = await next()) {
        statuses.push("failed"); // replaced by the record's status once the run returns
        bump(routine.name, 1);
        try {
          let result: RoutineRunResult;
          try {
            result = checkSinks(routine, await deps.runRoutine(routine, todo, ctl.signal));
            statuses[statuses.length - 1] = result.record.status;
            if (result.stopped) stoppedRun = true;
            await appendAndPrune(routine.name, result.record, () => (inFlight.get(routine.name) ?? 0) > 1);
          } finally {
            bump(routine.name, -1);
          }
          if (!result.stopped) await deps.deliverDigest(routine, result);
        } catch (err) {
          console.error(`bean: routine "${routine.name}" todo run failed`, err);
        }
      }
    } catch (err) {
      console.error(`bean: routine "${routine.name}" claim failed`, err);
    } finally {
      settleStop(routine.name, ctl);
      release(routine, statuses.length > 0 && !stoppedRun);
    }
    return { statuses, stopped: stoppedRun };
  }

  /** Starts runs into the routine's free slots (maxParallel − live). The slots are taken
   * synchronously, before any await, so concurrent fills never overcommit. Resolves when the
   * started runs end, with one status per run they made. Each run/worker's Stop handle is
   * registered here, with its slot. */
  async function fill(routine: Routine): Promise<FillResult> {
    const slots = deps.claimTodo ? parallelSlots(routine) : 1;
    const free = slots - count(routine.name);
    if (free <= 0) return { statuses: [], stopped: false };
    running.set(routine.name, count(routine.name) + free);
    if (slots === 1 || !deps.claimTodo) return execute(routine, admit(routine.name));
    const claim = deps.claimTodo;
    const ctls = Array.from({ length: free }, () => admit(routine.name));
    await stamp(routine.name).catch((err: unknown) => console.error(`bean: routine "${routine.name}" stamp failed`, err));
    const all = await Promise.all(ctls.map((ctl) => worker(routine, claim, ctl)));
    return { statuses: all.flatMap((r) => r.statuses), stopped: all.some((r) => r.stopped) };
  }

  /** Why a run can't start now (the same reasons Run now gives), or undefined. Synchronous, so a
   * caller can fill() right after with no await in between. */
  const refuseRun = (routine: Routine): string | undefined => {
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
  async function fireNotify(routine: Routine, items: WatchItem[], at: string): Promise<void> {
    const digest = watchDigest(items);
    const fired = checkSinks(routine, {
      digest, results: [], record: { startedAt: at, finishedAt: now().toISOString(), status: "ok", digest, steps: [] },
    });
    await appendAndPrune(routine.name, fired.record, () => count(routine.name) > 0);
    await deps.deliverDigest(routine, fired);
  }

  /** One poll: seed on first sight (fires nothing), otherwise diff against the seen-set.
   * Todo-driven watches only queue — the queue is the due signal tick() drains. */
  async function poll(routine: Routine): Promise<WatchCheckResult> {
    const watch = routine.watch;
    if (!watch || !deps.pollWatch || !deps.watchSeen) return { newItems: 0, error: "watch polling isn't available" };
    if (polling.has(routine.name)) return { newItems: 0, error: "already checking" };
    const at = now().toISOString();
    // A failed check OR a failed hand-off (todo insert, digest delivery) is one failure: it
    // shows on the status line and counts toward the alarm, and nothing gets marked seen.
    const fail = async (err: unknown): Promise<WatchCheckResult> => {
      const error = err instanceof Error ? err.message : String(err);
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
      // Edited while this poll was in flight: these results belong to the old source — drop
      // them rather than seeding/stamping the new one with them.
      const current = (await deps.loadRoutines()).find((r) => r.name === routine.name);
      if (!current?.watch || watchSourceKey(current.watch) !== watchSourceKey(watch)) return { newItems: 0 };
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
          await fireNotify(routine, fresh, at);
        } else {
          for (const item of fresh) {
            await deps.addTodo?.(routine.name, watchTodoText(item));
            deps.watchSeen.markNew(routine.name, [item.id]);
          }
        }
        deps.watchSeen.markNew(routine.name, ids); // refresh seen_at for everything still there
      }
      failures.delete(routine.name);
      await updateState(routine.name, (s) => ({ ...(s ?? { history: [] }), lastPoll: at, pollError: undefined }));
      return { newItems: fresh.length };
    } catch (err) {
      console.error(`bean: watch "${routine.name}" poll failed`, err);
      return await fail(err);
    } finally {
      polling.delete(routine.name);
    }
  }

  async function tick(): Promise<void> {
    // Flag candidates right after the routines load (before the states await) so an isRunning()
    // check made while a tick is still in flight sees them.
    const routines = await deps.loadRoutines();
    // A running watch still polls (and may fill free slots); a running cron routine waits — its
    // own run/workers already drain the queue.
    const candidates = routines.filter((r) => r.enabled && !checking.has(r.name) && (count(r.name) === 0 || r.watch));
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
    } catch (err) {
      unflag();
      throw err;
    }
    // Due routines start together (fill takes its slots synchronously, right after the flags clear).
    // One a Run now started while this tick was deciding (it dropped the flag) is already handled.
    const go = due.filter((r) => checking.get(r.name) === token);
    unflag();
    await Promise.all(go.map(fill));

    async function consider(routine: Routine, state: RoutineState | undefined, nowT: Date): Promise<void> {
      if (routine.watch) {
        // No cron, no missed-marking: a watch is due when its queue has work. The window gates
        // scheduled polls only (read against now(), since earlier polls this pass may be slow);
        // a skipped poll leaves lastPoll/failures alone, and draining is never gated.
        if (pollDue({ ...routine, watch: routine.watch }, state, nowT) && inWatchWindow(routine.watch.window, now())) await poll(routine);
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
    if (!routine?.watch) return { newItems: 0, error: `no watch sprout named "${name}"` };
    if (!routine.enabled) return { newItems: 0, error: "enable the sprout first" };
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
    /** Hosts with no Run-now (headless): drop the missed flag and rebase the schedule to now, so
     * each routine fires at its next slot — the missed one is still never run. */
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
    pollFailures: (name: string): number => failures.get(name) ?? 0,
    /** Refuses only when every slot is taken; otherwise fills the free ones and resolves once
     * they finish, with their worst status (none when no run happened) and whether one was stopped. */
    async runNow(name: string): Promise<{ started: boolean; reason?: string; status?: RunStatus; stopped?: true }> {
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine) return { started: false, reason: noSuch(name) };
      const reason = refuseRun(routine);
      if (reason) return { started: false, reason };
      checking.delete(name); // an in-flight tick's due decision for it is now stale
      const ran = await fill(routine); // no await between the check above and fill's synchronous slot grab
      return {
        started: true,
        ...(ran.statuses.length ? { status: triggerOutcome(ran.statuses).status } : {}),
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
    async trigger(name: string, action: "run" | "check"): Promise<TriggerResult> {
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine) return { status: "refused", reason: noSuch(name) };
      if (action === "check") return { status: "checked", result: await check(name, routine) };
      if (routine.todoDriven && routine.steps.length > 0 && deps.hasPendingTodos && !(await deps.hasPendingTodos(name))) {
        return { status: "refused", reason: "queue's empty now" };
      }
      const reason = refuseRun(routine);
      if (reason) return { status: "refused", reason };
      checking.delete(name);
      return { status: "started", done: fill(routine).then((r) => triggerOutcome(r.statuses)) }; // fill takes its slots synchronously
    },
    /** Enable from review: check the source again, seed from THAT check (not the build-time
     * preview), optionally queue what's already there, then save enabled. */
    async enableWatch(name: string, queueExisting: boolean): Promise<{ count: number }> {
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine?.watch) throw new Error(`no watch sprout named "${name}"`);
      if (!deps.pollWatch || !deps.watchSeen || !deps.saveRoutine) throw new Error("watch polling isn't available");
      if (polling.has(name)) throw new Error("already checking — try again in a moment");
      polling.add(name);
      try {
        const at = now().toISOString();
        const items = [...new Map((await deps.pollWatch(routine.watch)).map((i) => [i.id, i])).values()];
        // Queue first, seed after: a crash or failed insert in between leaves the watch unseeded
        // (still "needs review"), so the opted-in items are re-offered rather than lost.
        if (queueExisting && routine.todoDriven && routine.steps.length > 0) {
          for (const item of items) await deps.addTodo?.(name, watchTodoText(item));
        }
        deps.watchSeen.seed(name, watchSourceKey(routine.watch), items.map((i) => i.id));
        failures.delete(name);
        await updateState(name, (s) => ({ ...(s ?? { history: [] }), lastPoll: at, pollError: undefined }));
        await deps.saveRoutine({ ...routine, enabled: true });
        return { count: items.length };
      } finally {
        polling.delete(name);
      }
    },
  };
}
