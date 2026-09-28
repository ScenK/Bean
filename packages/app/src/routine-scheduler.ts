// packages/app/src/routine-scheduler.ts
import { appendRunRecord, nextRun, watchDigest, watchEveryMinutes, watchSourceKey, watchTodoText } from "@bean/core";
import type { Routine, RoutineRunResult, RoutineState, RoutineWatch, WatchItem } from "@bean/core";

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
  runRoutine: (routine: Routine) => Promise<RoutineRunResult>;
  deliverDigest: (routine: Routine, result: RoutineRunResult) => Promise<void>;
  now?: () => Date;
  /** Todo-driven gate: false = skip this fire (advance lastRun, record nothing). Absent = never skip. */
  hasPendingTodos?: (routine: string) => Promise<boolean>;
  /** Watch triggers (all optional — absent = watch routines never poll). */
  pollWatch?: (watch: RoutineWatch) => Promise<WatchItem[]>;
  watchSeen?: WatchSeenDeps;
  addTodo?: (routine: string, text: string) => Promise<void>;
  saveRoutine?: (routine: Routine) => Promise<void>;
  /** Fired once when a watch fails ALARM_AFTER polls in a row (desktop notification only —
   * never chatops sinks). Best-effort: the panel's status line is the guarantee. */
  alarm?: (routine: Routine, error: string) => void;
}

export interface WatchCheckResult { newItems: number; error?: string }

const TICK_MS = 30_000;
export const ALARM_AFTER = 3;

/** Due = the routine's next fire time after its schedule base has passed. The base is
 * lastRun when set, else the scheduler's start time — so a freshly saved routine waits
 * for its first real fire time instead of firing immediately, and schedules missed while
 * Bean was closed are marked missed (never auto-run: no catch-up by design). */
export function createRoutineScheduler(deps: RoutineSchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const running = new Set<string>();
  // In-memory mirror of which routines markMissed() flagged, checked by tick() instead of a
  // fresh loadStates() read: nextRun(cron, a stale lastRun) keeps landing on the same past
  // due time forever, so tick() needs to remember "already handled as missed" itself rather
  // than re-deriving it — a disk round-trip would also just re-observe the same stale due date.
  const missedNames = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

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

  // Consecutive poll failures, in memory (resets on restart — the alarm is a nudge, not a log).
  const failures = new Map<string, number>();
  const polling = new Set<string>();

  async function execute(routine: Routine): Promise<void> {
    running.add(routine.name);
    try {
      // Stamp lastRun at start so a crash mid-run doesn't refire the same slot forever.
      await updateState(routine.name, (prior) => ({ ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined }));
      missedNames.delete(routine.name); // clear in lockstep with the disk stamp above — an attempted
      // run (success or failure) counts as "handled," so a throw below can't leave tick() stuck
      // skipping this routine forever while disk already says not-missed.
      const result = await deps.runRoutine(routine);
      if (result.deferred) return; // a todo's project was busy — nothing ran, retry next tick
      await updateState(routine.name, (s) => appendRunRecord(s, result.record));
      await deps.deliverDigest(routine, result);
    } catch (err) {
      console.error(`bean: routine "${routine.name}" run failed`, err);
    } finally {
      running.delete(routine.name);
    }
  }

  const pollDue = (routine: Routine & { watch: RoutineWatch }, state: RoutineState | undefined, at: Date): boolean =>
    !state?.lastPoll || new Date(state.lastPoll).getTime() + watchEveryMinutes(routine.watch) * 60_000 <= at.getTime();

  /** New items on a notify-only watch: the digest is built here (no model, no runRoutine) and
   * one RunRecord is written per fire, so the Dashboard and run list show it. */
  async function fireNotify(routine: Routine, items: WatchItem[], at: string): Promise<void> {
    const digest = watchDigest(items);
    const record = { startedAt: at, finishedAt: now().toISOString(), status: "ok" as const, digest, steps: [] };
    await updateState(routine.name, (s) => appendRunRecord(s, record));
    await deps.deliverDigest(routine, { record, digest, results: [] });
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
    // Mark candidates running right after the routines load (before the states await) so an
    // isRunning() check made while a tick is still in flight sees the flag without racing the
    // second dependency load — ponytail: two sequential awaits would otherwise leave a window
    // where a concurrent tick/runNow could slip in between "decided to run" and "flagged running".
    const routines = await deps.loadRoutines();
    const candidates = routines.filter((r) => r.enabled && !running.has(r.name));
    // ponytail: marks ALL candidates running before due-ness is known, not just the one(s) that
    // turn out due — for the loadStates() await below (sub-ms to a few ms), isRunning()/runNow()
    // will wrongly report a non-due routine as running. Unavoidable without breaking the
    // overlap-skip test's single-microtask-tick timing; upgrade path if this bites in practice is
    // a separate "pending-due-check" set kept apart from the public running set.
    for (const routine of candidates) running.add(routine.name);
    const states = await deps.loadStates();
    const nowT = now();
    // Runs start only after every poll in this pass, so one long run can't stall other watches.
    const due: Routine[] = [];
    for (const routine of candidates) {
      try {
        await consider(routine);
      } catch (err) {
        // A transient failure (e.g. a SQLite lock in hasPendingTodos) must not leave the name
        // flagged running — later ticks would skip it for the rest of the session.
        console.error(`bean: routine "${routine.name}" due check failed`, err);
        running.delete(routine.name);
      }
    }
    for (const routine of due) await execute(routine);

    async function consider(routine: Routine): Promise<void> {
      const state = states[routine.name];
      if (routine.watch) {
        // No cron, no missed-marking: a watch is due when its queue has work.
        if (pollDue({ ...routine, watch: routine.watch }, state, nowT)) await poll(routine);
        const hasWork = routine.steps.length > 0 && routine.todoDriven && deps.hasPendingTodos
          ? await deps.hasPendingTodos(routine.name) : false;
        if (hasWork) due.push(routine);
        else running.delete(routine.name);
        return;
      }
      // A missed schedule stays missed until someone actually runs it (execute() clears the
      // flag) — no catch-up by design, otherwise nextRun(cron, stale lastRun) would keep
      // returning the same past due time and tick() would auto-run it on its very next pass.
      if (missedNames.has(routine.name)) { running.delete(routine.name); return; }
      let dueAt: Date;
      try {
        dueAt = nextRun(routine.cron ?? "", scheduleBase(state));
      } catch {
        running.delete(routine.name);
        return; // unparseable cron in a hand-edited file — skip, panel save validates
      }
      if (dueAt.getTime() <= nowT.getTime()) {
        if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) {
          // Empty queue: consume the slot without a run — otherwise this stale due time
          // refires every tick forever (same shape as the missed/no-catch-up rule).
          await updateState(routine.name, (prior) => ({ ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined }));
          running.delete(routine.name);
          return;
        }
        due.push(routine);
      } else {
        running.delete(routine.name);
      }
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
  }

  return {
    start(): void {
      void markMissed();
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    isRunning: (name: string): boolean => running.has(name),
    pollFailures: (name: string): number => failures.get(name) ?? 0,
    async runNow(name: string): Promise<{ started: boolean; reason?: string }> {
      if (running.has(name)) return { started: false, reason: "already running" };
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine) return { started: false, reason: `no routine named "${name}"` };
      if (routine.watch && routine.steps.length === 0) return { started: false, reason: "a notify-only watch has no steps to run — use Check now" };
      await execute(routine);
      return { started: true };
    },
    /** Poll a watch right now (runNow doesn't poll). New todo-driven items drain via a tick. */
    async checkNow(name: string): Promise<WatchCheckResult> {
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine?.watch) return { newItems: 0, error: `no watch routine named "${name}"` };
      if (!routine.enabled) return { newItems: 0, error: "enable the routine first" };
      const result = await poll(routine);
      if (result.newItems > 0 && routine.steps.length > 0) void tick();
      return result;
    },
    /** Enable from review: check the source again, seed from THAT check (not the build-time
     * preview), optionally queue what's already there, then save enabled. */
    async enableWatch(name: string, queueExisting: boolean): Promise<{ count: number }> {
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine?.watch) throw new Error(`no watch routine named "${name}"`);
      if (!deps.pollWatch || !deps.watchSeen || !deps.saveRoutine) throw new Error("watch polling isn't available");
      if (polling.has(name)) throw new Error("already checking — try again in a moment");
      polling.add(name);
      try {
        const at = now().toISOString();
        const items = [...new Map((await deps.pollWatch(routine.watch)).map((i) => [i.id, i])).values()];
        deps.watchSeen.seed(name, watchSourceKey(routine.watch), items.map((i) => i.id));
        if (queueExisting && routine.todoDriven && routine.steps.length > 0) {
          for (const item of items) await deps.addTodo?.(name, watchTodoText(item));
        }
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
