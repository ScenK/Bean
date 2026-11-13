// packages/core/src/routine-wiring.ts
import { randomUUID } from "node:crypto";
import type { ActionTool } from "./converse.js";
import type { CliName } from "./launcher.js";
import { dbFile, outboxDir, remindersFile, routinesDir, routineStateFile, skillsDir } from "./config.js";
import type { DelegateSpawnFn } from "./delegate.js";
import { loadMemories } from "./memory/store.js";
import type { CliModels } from "./cli-models.js";
import { availableModels, pinnedStepSelection, resolveDelegateSelection } from "./models.js";
import { enqueueOutbox } from "./outbox.js";
import { fireDueReminders, type ReminderDelivery } from "./reminders.js";
import { createRoutineHost, type RoutineHost, type RoutineHostDeps } from "./routine-host.js";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "./routine-scheduler.js";
import { makeRoutineSteps } from "./routine-steps.js";
import { loadRoutines, loadRoutineStates, saveRoutine, saveRoutineStates, type RoutineWatch } from "./routine-store.js";
import { loadLayeredSkills } from "./skill-library.js";
import { pruneStepAttempts } from "./step-attempts.js";
import { addTodo, claimTodo, listTodos, recoverInterruptedTodos } from "./todo-store.js";
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
  getRoutineDigestContext: () => boolean;
  onStatus?: RoutineHostDeps["onStatus"];
  notify?: RoutineHostDeps["notify"];
  /** The scheduler lease (safety-one-scheduler-per-data-dir): gates every automatic fire. */
  canSchedule: () => boolean;
  alarm: NonNullable<RoutineSchedulerDeps["alarm"]>;
  onMissed?: RoutineSchedulerDeps["onMissed"];
}

export interface RoutineWiring {
  host: RoutineHost;
  scheduler: ReturnType<typeof createRoutineScheduler>;
  /** The same feed/command poller the scheduler uses (previews, the sprout builder). */
  pollWatch: (watch: RoutineWatch) => Promise<WatchItem[]>;
  /** Lease holder only: fails todos the previous holder left `running` (retryable), then starts
   * the scheduler if the lease is still held. Recovery errors are logged, never block the start. */
  start: () => Promise<void>;
}

/** The routine host + scheduler (steps, watch polling, todo queue) every scheduling host runs —
 * the desktop app and the headless bot differ only in the injected sinks, CLIs and lease. */
export function createRoutineWiring(deps: RoutineWiringDeps): RoutineWiring {
  const { dir } = deps;
  const db = dbFile(dir);
  const steps = makeRoutineSteps({
    dir,
    // A pinned harness refuses here, before any reservation or spawn — never a silent swap.
    selectCli: (req) => req.cli
      ? pinnedStepSelection({ cli: req.cli, model: req.model }, deps.clis(), availableModels(deps.cliModels, deps.clis()))
      : resolveDelegateSelection(deps.cliModels, deps.clis(), deps.getDelegateCli(), req.model),
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    path: deps.path,
  });
  const host = createRoutineHost({
    dir,
    converse: deps.converse,
    getModel: deps.getModel,
    delegateStep: steps.delegateStep,
    commandStep: steps.commandStep,
    tools: deps.tools,
    loadSkills: () => loadLayeredSkills(skillsDir(deps.builtinDir), skillsDir(dir)),
    // Household-shared only: routines never see a member's private facts.
    memories: () => loadMemories(db, null),
    getRoutineDigestContext: deps.getRoutineDigestContext,
    ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
  });
  const watchPoll = { fetchText, exec: execWatchCommand(deps.path) };
  const poll = (w: RoutineWatch): Promise<WatchItem[]> => pollWatch(w, watchPoll);
  const scheduler = createRoutineScheduler({
    canSchedule: deps.canSchedule,
    loadRoutines: () => loadRoutines(routinesDir(dir)),
    loadStates: () => loadRoutineStates(routineStateFile(dir)),
    saveStates: (s) => saveRoutineStates(routineStateFile(dir), s),
    runRoutine: host.runOneRoutine,
    deliverDigest: host.deliverDigest,
    sinkProblems: host.sinkProblems,
    pruneAttempts: (r, keep) => pruneStepAttempts(db, r, keep),
    hasPendingTodos: async (r) => (await listTodos(db, r)).some((t) => t.status === "pending"),
    claimTodo: (r) => claimTodo(db, r),
    pollWatch: poll,
    watchSeen: {
      isSeeded: (r, source) => isWatchSeeded(db, r, source),
      seed: (r, source, ids) => seedWatch(db, r, source, ids),
      unseen: (r, ids) => unseenIds(db, r, ids),
      markNew: (r, ids) => markNewItems(db, r, ids),
    },
    addTodo: async (r, text) => { await addTodo(db, r, text); },
    saveRoutine: (r) => saveRoutine(routinesDir(dir), r),
    alarm: deps.alarm,
    ...(deps.onMissed ? { onMissed: deps.onMissed } : {}),
  });
  const start = async (): Promise<void> => {
    try {
      const n = await recoverInterruptedTodos(db);
      if (n > 0) console.warn(`bean: marked ${n} interrupted todo(s) as failed`);
    } catch (err) {
      console.error("bean: interrupted-todo recovery failed", err);
    }
    if (deps.canSchedule()) scheduler.start();
  };
  return { host, scheduler, pollWatch: poll, start };
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
