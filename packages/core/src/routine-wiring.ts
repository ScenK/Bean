// packages/core/src/routine-wiring.ts
import { randomUUID } from "node:crypto";
import type { ActionTool } from "./converse.js";
import type { CliName } from "./launcher.js";
import { dbFile, outboxDir, personaFile, remindersFile, routinesDir, routineStateFile, skillsDir } from "./config.js";
import type { DelegateSpawnFn } from "./delegate.js";
import { deliverDispatches, interruptOpenDispatches, type Dispatch } from "./dispatch-store.js";
import { loadMemories } from "./memory/store.js";
import { loadPersona } from "./persona-store.js";
import { resolveWireModel, type CliModels } from "./cli-models.js";
import { availableModels, pinnedStepSelection, resolveDelegateSelection } from "./models.js";
import { enqueueOutbox } from "./outbox.js";
import { fireDueReminders, type ReminderDelivery } from "./reminders.js";
import { createRoutineHost, type RoutineHost, type RoutineHostDeps } from "./routine-host.js";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "./routine-scheduler.js";
import { makeRoutineSteps } from "./routine-steps.js";
import { loadRoutines, loadRoutineStates, saveRoutine, saveRoutineStates, type RoutineWatch } from "./routine-store.js";
import { loadLayeredSkills } from "./skill-library.js";
import { pruneStepAttempts } from "./step-attempts.js";
import { addTodo, claimTodo, claimTodoById, dropPendingTodos, listTodos, recoverInterruptedTodos } from "./todo-store.js";
import { pollWatch, type WatchItem } from "./watch.js";
import { execWatchCommand, fetchText } from "./watch-io.js";
import { isWatchSeeded, markNewItems, seedWatch, unseenIds } from "./watch-store.js";

export interface RoutineWiringDeps {
  /** ~/.bean — routines, state, bean.db, outbox and run records all derive from it. */
  dir: string;
  /** The repo/bundled `.bean` whose skills layer under the user's. */
  builtinDir: string;
  converse: RoutineHostDeps["converse"];
  getModel: () => string;
  /** Recall by meaning for step memories; absent = keyword recall. */
  rankByMeaning?: RoutineHostDeps["rankByMeaning"];
  /** config.json's `briefModel` (read at boot); absent = getModel(). */
  getBriefModel?: () => string | undefined;
  /** Enabled CLIs, read per step. */
  clis: () => CliName[];
  cliModels: CliModels[];
  /** config.json's delegateCli preference ("" = first enabled), read per step. */
  getDelegateCli: () => string;
  /** PATH for delegate/command steps and command watches (safety-packaged-app-path-detection). */
  path: string;
  /** Delegate spawn; absent = core's default. */
  spawnFn?: DelegateSpawnFn;
  /** Act-now tools for chat steps. */
  tools: ActionTool[];
  onStatus?: RoutineHostDeps["onStatus"];
  notify?: RoutineHostDeps["notify"];
  onHomePost?: RoutineHostDeps["onHomePost"];
  homeDms?: RoutineHostDeps["homeDms"];
  /** The scheduler lease (safety-one-scheduler-per-data-dir): gates every automatic fire. */
  canSchedule: () => boolean;
  alarm: NonNullable<RoutineSchedulerDeps["alarm"]>;
  onMissed?: RoutineSchedulerDeps["onMissed"];
  /** Posts a closed sprout dispatch's result at its origin (#919). False = this host can't reach
   * that origin; the row stays owed. Absent = owed results wait. */
  deliverDispatch?: (d: Dispatch) => Promise<boolean>;
}

export interface RoutineWiring {
  host: RoutineHost;
  scheduler: ReturnType<typeof createRoutineScheduler>;
  /** The same feed/command poller the scheduler uses (previews, the sprout builder). */
  pollWatch: (watch: RoutineWatch) => Promise<WatchItem[]>;
  /** Lease holder only: fails todos the previous holder left `running` (retryable), then starts
   * the scheduler if the lease is still held. Recovery errors are logged, never block the start.
   * Also closes dispatches left open as interrupted and delivers every owed result. */
  start: () => Promise<void>;
  /** Delivers every closed, undelivered dispatch once (also runs after each run's digest). */
  deliverDispatches: () => Promise<void>;
}

/** The routine host + scheduler (steps, watch polling, todo queue) every scheduling host runs —
 * the desktop app and the headless bot differ only in the injected sinks, CLIs and lease. */
export function createRoutineWiring(deps: RoutineWiringDeps): RoutineWiring {
  const { dir } = deps;
  const db = dbFile(dir);
  const steps = makeRoutineSteps({
    dir,
    // A pinned harness refuses here, before any reservation or spawn — never a silent swap.
    selectCli: (req) => {
      const picked = req.cli
        ? pinnedStepSelection({ cli: req.cli, model: req.model, effort: req.effort }, deps.clis(), availableModels(deps.cliModels, deps.clis()))
        : resolveDelegateSelection(deps.cliModels, deps.clis(), deps.getDelegateCli(), req.model, req.effort);
      if (!picked) return undefined;
      const wire = resolveWireModel(deps.cliModels, picked.cli, picked.model, picked.effort);
      return { cli: picked.cli, ...(wire.model ? { model: wire.model } : {}), ...(wire.effort ? { effort: wire.effort } : {}) };
    },
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    path: deps.path,
  });
  const host = createRoutineHost({
    dir,
    converse: deps.converse,
    getModel: deps.getModel,
    ...(deps.getBriefModel ? { getBriefModel: deps.getBriefModel } : {}),
    // The same user file → bundled file → default chain chat and the bots use.
    loadPersona: () => loadPersona(personaFile(dir), personaFile(deps.builtinDir)),
    delegateStep: steps.delegateStep,
    commandStep: steps.commandStep,
    tools: deps.tools,
    loadSkills: () => loadLayeredSkills(skillsDir(deps.builtinDir), skillsDir(dir)),
    // Household-shared only: routines never see a member's private facts.
    // The owner's own automation: shared rows from every channel, never a private one.
    memories: () => loadMemories(db, null, { allSources: true }),
    rankByMeaning: deps.rankByMeaning,
    holdsLease: deps.canSchedule,
    ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
    ...(deps.onHomePost ? { onHomePost: deps.onHomePost } : {}),
    ...(deps.homeDms ? { homeDms: deps.homeDms } : {}),
  });
  const watchPoll = { fetchText, exec: execWatchCommand(deps.path) };
  const poll = (w: RoutineWatch): Promise<WatchItem[]> => pollWatch(w, watchPoll);
  const scheduler = createRoutineScheduler({
    canSchedule: deps.canSchedule,
    loadRoutines: () => loadRoutines(routinesDir(dir)),
    loadStates: () => loadRoutineStates(routineStateFile(dir)),
    saveStates: (s) => saveRoutineStates(routineStateFile(dir), s),
    runRoutine: host.runOneRoutine,
    // After each run: a dispatch following a todo this run finished is now owed.
    deliverDigest: async (r, result, brief, origin) => {
      const body = await host.deliverDigest(r, result, brief, origin);
      void sweep();
      return body;
    },
    sinkProblems: host.sinkProblems,
    pruneAttempts: (r, keep) => pruneStepAttempts(db, r, keep),
    hasPendingTodos: async (r) => (await listTodos(db, r)).some((t) => t.status === "pending"),
    claimTodo: (r) => claimTodo(db, r),
    claimTodoById: (id) => claimTodoById(db, id),
    pollWatch: poll,
    watchSeen: {
      isSeeded: (r, source) => isWatchSeeded(db, r, source),
      seed: (r, source, ids) => seedWatch(db, r, source, ids),
      unseen: (r, ids) => unseenIds(db, r, ids),
      markNew: (r, ids) => markNewItems(db, r, ids),
    },
    addTodo: async (r, text) => { await addTodo(db, r, text); },
    saveRoutine: (r) => saveRoutine(routinesDir(dir), r),
    // The dropped todos' chat receipts were just closed: hand them off now.
    dropPendingTodos: async (r) => { await dropPendingTodos(db, r); void sweep(); },
    alarm: deps.alarm,
    ...(deps.onMissed ? { onMissed: deps.onMissed } : {}),
  });
  const sweep = async (): Promise<void> => {
    const deliver = deps.deliverDispatch;
    // Holder only: its start releases a dead holder's half-done claims, which assumes no live
    // sweeper elsewhere. A skipped sweep loses nothing — the next one (or start) delivers.
    if (!deliver || !deps.canSchedule()) return;
    await deliverDispatches(db, deliver).catch((err: unknown) => console.error("bean: sprout dispatch delivery failed", err));
  };
  const start = async (): Promise<void> => {
    // First, before any await: a dispatch admitted after this point belongs to this holder.
    try {
      const n = interruptOpenDispatches(db);
      if (n > 0) console.warn(`bean: closed ${n} interrupted sprout dispatch(es)`);
    } catch (err) {
      console.error("bean: interrupted-dispatch recovery failed", err);
    }
    try {
      const n = await recoverInterruptedTodos(db);
      if (n > 0) console.warn(`bean: marked ${n} interrupted todo(s) as failed`);
    } catch (err) {
      console.error("bean: interrupted-todo recovery failed", err);
    }
    if (deps.canSchedule()) scheduler.start();
    await sweep();
  };
  return { host, scheduler, pollWatch: poll, start, deliverDispatches: sweep };
}

/** The 30s reminder loop, lease-gated like the scheduler. Targeted (chatops) reminders go to the
 * outbox; the host decides what an untargeted one becomes. Returns the stop. */
export function startReminderLoop(deps: {
  dir: string;
  canRun: () => boolean;
  untargeted: ReminderDelivery["untargeted"];
  failed: ReminderDelivery["failed"];
}): () => void {
  const timer = setInterval(() => {
    if (!deps.canRun()) return;
    fireDueReminders(remindersFile(deps.dir), new Date(), {
      untargeted: deps.untargeted,
      enqueue: (msg) => enqueueOutbox(outboxDir(deps.dir), msg, randomUUID),
      failed: deps.failed,
    }).catch((err: unknown) => console.error("bean: reminder loop failed", err));
  }, 30_000);
  return () => clearInterval(timer);
}
