import {
  addTodo, claimTodo, clearReservations, killAllCommands, killAllDelegates, createRoutineHost, createRoutineScheduler, dbFile, enqueueOutbox, execWatchCommand, fetchText,
  isWatchSeeded, listTodos, loadLayeredSkills, loadMemories, loadRoutines, loadRoutineStates, makeRoutineSteps, markNewItems,
  outboxDir, fireDueReminders, remindersFile, pinnedStepSelection, pollWatch, pruneStepAttempts, recoverInterruptedTodos, resolveDelegateSelection,
  retrieveNoteTool, routinesDir, routineStateFile, availableModels, saveRoutine, saveRoutineStates, searchNotes, seedWatch,
  skillsDir, unseenIds,
  type CliModels, type CliName, type RoutineHostDeps,
} from "@bean/core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The bot-server switch. Off by default: on the Mac the desktop app owns the scheduler and
 * spawns this bot, and two schedulers on one ~/.bean would double-fire every routine. */
export const HEADLESS_ROUTINES_ENV = "BEAN_HEADLESS_ROUTINES";
export const headlessRoutinesOn = (env: NodeJS.ProcessEnv): boolean => env[HEADLESS_ROUTINES_ENV] === "1";

/** cron matches in local time, so an unset TZ silently fires in whatever the container defaults to. */
export const tzProblem = (env: NodeJS.ProcessEnv): string | undefined =>
  env.TZ ? undefined : `bean: ${HEADLESS_ROUTINES_ENV}=1 needs TZ set (e.g. TZ=America/Toronto) — cron routines fire in local time.`;

/** Best-effort "can this CLI log in" for the boot log: its token env var or its credentials file. */
export function cliAuthPresent(cli: CliName, env: NodeJS.ProcessEnv, home: string, exists: (p: string) => boolean = existsSync): boolean {
  if (cli === "claude") {
    return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ||
      exists(join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"));
  }
  if (cli === "codex") return exists(join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
  return exists(join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "auth.json"));
}

export const missedNotice = (names: string[]): string =>
  `Missed while Bean was down (not run — no catch-up): ${names.map((n) => `"${n}"`).join(", ")}. They resume at their next slot.`;

export const clearedNotice = (paths: string[]): string =>
  `Cleared ${paths.length} stale run reservation(s) left by the last shutdown: ${paths.join(", ")}. Those runs were stopped.`;

export interface HeadlessRoutineDeps {
  dir: string;
  builtinDir: string;
  converse: RoutineHostDeps["converse"];
  model: string;
  clis: () => CliName[];
  cliModels: CliModels[];
  /** config.json's delegateCli preference ("" = first enabled). */
  delegateCli: string;
  routineDigestContext: boolean;
  ownerId: string;
}

/** The bot server as a routine host (#279): one scheduler + routine host in this process, so it
 * alone owns .state.json. Desktop notices (watch alarm, `notify` sinks, missed runs) become owner
 * DMs through the outbox this same process drains. Returns the SIGTERM shutdown. */
export async function startHeadlessRoutines(deps: HeadlessRoutineDeps): Promise<() => Promise<void>> {
  const { dir } = deps;
  const ownerDm = (body: string, title?: string): Promise<void> =>
    enqueueOutbox(outboxDir(dir), { transport: "discord", body, ...(title ? { title } : {}) }, randomUUID)
      .then(() => {}, (err: unknown) => console.error("bean: owner notice failed", err));

  const recovered = await recoverInterruptedTodos(dbFile(dir));
  if (recovered > 0) console.warn(`bean: marked ${recovered} interrupted todo(s) as failed`);
  const cleared = clearReservations(dir);
  if (cleared.length > 0) await ownerDm(clearedNotice(cleared));

  const steps = makeRoutineSteps({
    dir,
    selectCli: (req) => req.cli
      ? pinnedStepSelection({ cli: req.cli, model: req.model }, deps.clis(), availableModels(deps.cliModels, deps.clis()))
      : resolveDelegateSelection(deps.cliModels, deps.clis(), deps.delegateCli, req.model),
    path: process.env.PATH ?? "",
  });
  const host = createRoutineHost({
    dir,
    converse: deps.converse,
    getModel: () => deps.model,
    delegateStep: steps.delegateStep,
    commandStep: steps.commandStep,
    tools: [retrieveNoteTool((q) => searchNotes(dbFile(dir), q))],
    loadSkills: () => loadLayeredSkills(skillsDir(deps.builtinDir), skillsDir(dir)),
    // Household-shared memories only — never a member's private facts.
    memories: () => loadMemories(dbFile(dir), null),
    getRoutineDigestContext: () => deps.routineDigestContext,
    notify: (msg) => ownerDm(msg.body, msg.title),
  });
  const watchPoll = { fetchText, exec: execWatchCommand(process.env.PATH ?? "") };
  const scheduler = createRoutineScheduler({
    loadRoutines: () => loadRoutines(routinesDir(dir)),
    loadStates: () => loadRoutineStates(routineStateFile(dir)),
    saveStates: (s) => saveRoutineStates(routineStateFile(dir), s),
    runRoutine: host.runOneRoutine,
    deliverDigest: host.deliverDigest,
    pruneAttempts: (r, keep) => pruneStepAttempts(dbFile(dir), r, keep),
    hasPendingTodos: async (r) => (await listTodos(dbFile(dir), r)).some((t) => t.status === "pending"),
    claimTodo: (r) => claimTodo(dbFile(dir), r),
    pollWatch: (w) => pollWatch(w, watchPoll),
    watchSeen: {
      isSeeded: (r, source) => isWatchSeeded(dbFile(dir), r, source),
      seed: (r, source, ids) => seedWatch(dbFile(dir), r, source, ids),
      unseen: (r, ids) => unseenIds(dbFile(dir), r, ids),
      markNew: (r, ids) => markNewItems(dbFile(dir), r, ids),
    },
    addTodo: async (r, text) => { await addTodo(dbFile(dir), r, text); },
    saveRoutine: (r) => saveRoutine(routinesDir(dir), r),
    alarm: (routine, error) => void ownerDm(`Can't check for new items — ${error}`, `Sprout: ${routine.name}`),
    // No Run-now button here: rebase each to its next slot (still no catch-up), or the scheduler's
    // missed guard would skip it forever.
    onMissed: (names) => {
      void ownerDm(missedNotice(names));
      void scheduler.clearMissed(names).catch((err: unknown) => console.error("bean: clearing missed routines failed", err));
    },
  });

  const clis = deps.clis();
  const home = process.env.HOME ?? "";
  const auth = clis.map((c) => `${c}=${cliAuthPresent(c, process.env, home) ? "yes" : "no"}`).join(" ");
  const routines = await loadRoutines(routinesDir(dir));
  console.log(
    `@bean/discord headless routines on: TZ=${process.env.TZ}, clis: ${clis.join(", ") || "none"} (auth ${auth || "n/a"}), ` +
      `${routines.length} routine(s) (${routines.filter((r) => r.enabled).length} enabled), owner ${deps.ownerId}`,
  );
  scheduler.start();

  // Reminders: the desktop app's 30s loop, here. Targeted ones go through the outbox this
  // process drains; untargeted (desktop-set) ones become owner DMs like the other notices.
  const reminderTimer = setInterval(() => {
    fireDueReminders(remindersFile(dir), new Date(), {
      untargeted: (r) => ownerDm(r.text, "⏰ Reminder"),
      enqueue: (msg) => enqueueOutbox(outboxDir(dir), msg, randomUUID),
      failed: (r, err) => console.error(`bean: reminder ${r.id} not delivered`, err),
    }).catch((err: unknown) => console.error("bean: reminder loop failed", err));
  }, 30_000);

  return async () => {
    clearInterval(reminderTimer);
    scheduler.stop();
    // A state write stuck on a dead disk must not hang shutdown past the container's grace period.
    await Promise.race([scheduler.settle(), new Promise((r) => setTimeout(r, 5_000))]);
    // Every delegate (routine and chat) and command step: the process exits next, and boot
    // cleanup would kill whatever survived anyway.
    killAllDelegates();
    killAllCommands();
  };
}
