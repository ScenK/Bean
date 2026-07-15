// packages/app/src/routine-scheduler.ts
import { appendRunRecord, nextRun } from "@bean/core";
import type { Routine, RoutineRunResult, RoutineState } from "@bean/core";

export interface RoutineSchedulerDeps {
  loadRoutines: () => Promise<Routine[]>;
  loadStates: () => Promise<Record<string, RoutineState>>;
  saveStates: (states: Record<string, RoutineState>) => Promise<void>;
  runRoutine: (routine: Routine) => Promise<RoutineRunResult>;
  deliverDigest: (routine: Routine, result: RoutineRunResult) => Promise<void>;
  now?: () => Date;
  /** Todo-driven gate: false = skip this fire (advance lastRun, record nothing). Absent = never skip. */
  hasPendingTodos?: (routine: string) => Promise<boolean>;
}

const TICK_MS = 30_000;

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

  async function execute(routine: Routine): Promise<void> {
    running.add(routine.name);
    try {
      // Stamp lastRun at start so a crash mid-run doesn't refire the same slot forever.
      const before = await deps.loadStates();
      const prior = before[routine.name];
      await deps.saveStates({
        ...before,
        [routine.name]: { ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined },
      });
      missedNames.delete(routine.name); // clear in lockstep with the disk stamp above — an attempted
      // run (success or failure) counts as "handled," so a throw below can't leave tick() stuck
      // skipping this routine forever while disk already says not-missed.
      const result = await deps.runRoutine(routine);
      const after = await deps.loadStates();
      await deps.saveStates({ ...after, [routine.name]: appendRunRecord(after[routine.name], result.record) });
      await deps.deliverDigest(routine, result);
    } catch (err) {
      console.error(`bean: routine "${routine.name}" run failed`, err);
    } finally {
      running.delete(routine.name);
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
    for (const routine of candidates) {
      const state = states[routine.name];
      // A missed schedule stays missed until someone actually runs it (execute() clears the
      // flag) — no catch-up by design, otherwise nextRun(cron, stale lastRun) would keep
      // returning the same past due time and tick() would auto-run it on its very next pass.
      if (missedNames.has(routine.name)) { running.delete(routine.name); continue; }
      let due: Date;
      try {
        due = nextRun(routine.cron, scheduleBase(state));
      } catch {
        running.delete(routine.name);
        continue; // unparseable cron in a hand-edited file — skip, panel save validates
      }
      if (due.getTime() <= nowT.getTime()) {
        if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) {
          // Empty queue: consume the slot without a run — otherwise this stale due time
          // refires every tick forever (same shape as the missed/no-catch-up rule).
          const before = await deps.loadStates();
          const prior = before[routine.name];
          await deps.saveStates({
            ...before,
            [routine.name]: { ...(prior ?? { history: [] }), lastRun: now().toISOString(), missed: undefined },
          });
          running.delete(routine.name);
          continue;
        }
        await execute(routine);
      } else {
        running.delete(routine.name);
      }
    }
  }

  /** Flag routines whose fire time passed while Bean was closed (base = lastRun, fire < startedAt). */
  async function markMissed(): Promise<void> {
    const [routines, states] = await Promise.all([deps.loadRoutines(), deps.loadStates()]);
    let changed = false;
    const next = { ...states };
    for (const routine of routines) {
      const state = states[routine.name];
      if (!routine.enabled || !state?.lastRun || state.missed) continue;
      try {
        if (nextRun(routine.cron, new Date(state.lastRun)).getTime() < startedAt.getTime()) {
          // A todo-driven routine's missed fire is only a real problem if there's still
          // pending work to catch up on — an empty queue means tick()'s own hasPendingTodos
          // gate would have silently skipped that fire anyway, so flagging it missed here
          // would be a false alarm the user can't act on (and it'd get stuck: missedNames
          // makes tick() skip re-checking due-ness until someone manually runs it).
          if (routine.todoDriven && deps.hasPendingTodos && !(await deps.hasPendingTodos(routine.name))) continue;
          next[routine.name] = { ...state, missed: true };
          missedNames.add(routine.name);
          changed = true;
        }
      } catch { /* bad cron — ignore */ }
    }
    if (changed) await deps.saveStates(next);
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
    async runNow(name: string): Promise<{ started: boolean; reason?: string }> {
      if (running.has(name)) return { started: false, reason: "already running" };
      const routine = (await deps.loadRoutines()).find((r) => r.name === name);
      if (!routine) return { started: false, reason: `no routine named "${name}"` };
      await execute(routine);
      return { started: true };
    },
  };
}
