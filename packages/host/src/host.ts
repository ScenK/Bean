import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  configFile, projectsFile, skillsDir, personaFile, dbFile, remindersFile, modelMemoryFile, clisFile, routinesDir, routineStateFile, outboxDir,
  scratchDir, imagesDir, isValidSessionId, resumeCommand, pruneStepAttempts, listStepAttempts, CLI_NAMES, watchCliModels,
  loadConfig, saveConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, loadPersonaNameSync, savePersona,
  makeOpenAIConverse, makeOpenAIEmbed, makeRankByMeaning, makeOpenAIImageGen, loadMemories, appendMemories, updateMemory, updateMemoryCategory, renameMemoryCategory,
  deleteMemories, extractMemories, maybeDream, getMemoryMeta, restoreDreamRun, dreamDetails, holdSchedulerLease, enqueueOutbox,
  answerRoutineTrigger, answerTodoRun, queueTodoDispatch, pendingTodoCount, resolveTodoRoutine, sproutRunFacts, withDispatch, enqueueDispatchNotice, threadDispatches, markDispatchDelivered, dispatchContext, type Dispatch, loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote,
  loadNoteHistory, saveNoteImage, loadNoteImage, detectClis, loginShellPath, resolveCliPath, deliver, loadRoutines, saveRoutine,
  deleteRoutine, loadRoutineStates, runDelegate, killAllDelegates, killAllCommands, ROUTINE_STEP_TIMEOUT_MS, addTodo, listTodos,
  listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo, deleteTodosForRoutine, sweepDeadRuns,
  isWatchSeeded, clearWatch, watchSourceKey, briefMessages, parseBrief, isLiveCli, findDelegateRun, saveDesktopChat, getDesktopChat,
  deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats, renameDesktopChatGroup, listDesktopChats, listPendingHomePosts, saveDesktopChatDraining, countPendingHomePosts, nextHomePostExpiry, migrateOwnerDmSinks, detectTools,
  fetchText, createRoutineWiring, startReminderLoop, sinkRecipients, ownerSubjectIds, listDestinations, destinationLabel,
  matchDestination, ambientSpeakers, setAlias, clearAlias, retargetAlias, sinkAliasProblems, loadChatopsOwners, loadModelMemory,
  saveModelMemory, resolveDelegateSelection, liveRuns, ConversationStore, mainCutover, runMainCutover, HOME_THREAD_ID, MAIN_CONVERSATION_ID,
  type CliModels, type CliName, type ChatopsSurface, type DreamDigest, type Reminder, type Routine, type RoutineTrigger,
  type RoutineTriggerAnswer, type Transport,
} from "@bean/core";
import { buildActionTools } from "./action-tools.js";
import { createAttachments } from "./attachments.js";
import { buildChatHandler, buildChatThreadHandlers, buildModelMemoryHandlers, buildModelsHandler } from "./chat.js";
import { createChatSessions } from "./chat-sessions.js";
import type { ConfigView } from "./config.js";
import { createDelegateTasks, resolvedPathSpawnFn } from "./delegate-tasks.js";
import { buildDestinationHandlers, buildSendHandlers } from "./destinations.js";
import {
  buildDeleteSkillHandler, buildListProjectsHandler, buildListSkillsHandler, buildSaveProjectsHandler, buildSaveSkillHandler,
  buildPersonaHandlers, buildSkillProposalHandlers, buildTodoHandlers,
} from "./handlers.js";
import { createLiveTasks, LIVE_AGENT_NAMES } from "./live-tasks.js";
import { buildMemoryHandlers } from "./memory.js";
import { startMemoryDigest } from "./memory-digest.js";
import { startBots, type HostBotsOptions } from "./bots.js";
import { buildNotesHandlers } from "./notes.js";
import { createRoutineBuilder } from "./routine-builder.js";
import { buildRoutineHandlers } from "./routines.js";
import { buildRoutineDraftHandlers } from "./routine-drafts.js";
import type { ClientId, HostPush } from "./shell-ops.js";
import { createRoutineBubbles, createTaskStatus, type TaskJob } from "./task-status.js";
import { createHomeBubble } from "./home-bubble.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { busyWork, UPDATING, type CoreLatch } from "./core-update.js";

export interface HostDeps {
  /** The data directory (`~/.bean`), already created private. */
  dir: string;
  /** The built-in `.bean` (the repo's, or the packaged app's `Resources/builtin`). */
  builtinDir: string;
  /** Mount-tagged pushes; the shell adapter routes them to the client holding the chat. */
  push: HostPush;
  /** Every change of the status list (the avatar's bubbles, the shell's keep-awake). */
  onJobs: (jobs: TaskJob[]) => void;
  /** Desktop notifications (reminders, sprout digests and alarms); dropped while unavailable. */
  notification: Transport;
  /** Whether a client is the chat window — the only client that may drive chats and agent sessions. */
  isChatClient: (clientId: ClientId) => boolean;
  /** Registers a synchronous teardown for the shell's quit. */
  onQuit: (fn: () => void) => void;
  /** True only the first time memory saves itself (the one-time heads-up), then false. */
  firstAutoMemory: () => Promise<boolean>;
  /** Shell-owned per-chat state to drop with a released chat (the desktop's terminals). */
  onChatRelease?: (mountId: string) => void;
  /** The Discord and Teams bots, which the host supervises and autostarts (#805). */
  bots: HostBotsOptions;
  /** No desktop shell (`bean-core`, #806): the lease is labelled for it, a lost lease calls this
   * (the service manager restarts the process, which then stands by), and missed sprouts get a
   * notice and are rebased to their next slot — there is no Run-now button to clear them. */
  headless?: { onLeaseLost: () => void };
}

export const missedNotice = (names: string[]): string =>
  `Missed while Bean was down (not run — no catch-up): ${names.map((n) => `"${n}"`).join(", ")}. They resume at their next slot.`;

/** The Electron-free host: the stateful registries (chat mounts and turns, delegates, live sessions,
 * status bubbles, runtime config, routine builder), the scheduler lease, the reminder loop, the
 * sprout scheduler, the Discord and Teams bots, and every handler the shell's IPC adapter wires to a
 * channel. Throws when the config can't load. */
export async function createHost(deps: HostDeps) {
  const { dir, builtinDir: projectDir } = deps;
  const db = dbFile(dir);
  // What Bean is working on, and what failed (design 2a).
  const taskStatus = createTaskStatus(deps.onJobs);
  // A core update's admission latch (#837, core-update.ts): closed from its busy check until the
  // process exits (or the update is refused / fails). Closed = no new starts, no scheduled fires.
  let updating = false;
  const refuseStart = (): string | undefined => (updating ? UPDATING : undefined);
  // Starts admitted while open whose work isn't a running job yet (async checks before a delegate or
  // live session registers, a sprout run before its bubble, a builder agent that never gets one):
  // busy until they settle, or a latch closed in that gap would read idle.
  let pendingStarts = 0;
  const track = <T>(start: Promise<T>): Promise<T> => {
    pendingStarts++;
    return start.finally(() => { pendingStarts--; });
  };
  // A remote shell's attachment (#808): its chats' pushes are numbered and buffered for a replay, and
  // a lost shell's work waits out the grace. Local windows never attach; their pushes pass through.
  const attachments = createAttachments({
    holder: (id) => sessions.holder(id), ofClient: (c) => sessions.ofClient(c), abortTurn: (id) => sessions.abortTurn(id),
    expire: (c) => sessions.expireClient(c), release: (c) => sessions.releaseClient(c),
  });
  const push = attachments.push(deps.push);
  const isChatClient = (c: ClientId): boolean => deps.isChatClient(c) || attachments.isClient(c);

  // Finder-launched Electron gets a minimal PATH missing whatever the user's shell profile
  // adds (nvm, npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real
  // PATH once. CLI detection is re-scanned per resolution (cheap sync stat) so a CLI
  // installed after boot is picked up without a relaunch.
  const resolvedPath = resolveCliPath(process.env.PATH ?? "", loginShellPath(), homedir());
  const detectedClis = (): CliName[] => detectClis(resolvedPath);
  // Same repo-default + ~/.bean override layering as skills/persona. Live: an edit to
  // ~/.bean/clis.json refills this same array in place, so every holder below sees it.
  const clisWatch = await watchCliModels(clisFile(projectDir), clisFile(dir));
  const cliModels: CliModels[] = clisWatch.cliModels;
  deps.onQuit(clisWatch.stop);

  // Chatops reminders (a `target`) go to the outbox for their bot (Discord / Teams) to deliver; untargeted
  // ones stay desktop notifications.
  const reminderFailed = (r: Reminder, err: unknown): void => {
    console.error("bean: reminder delivery failed", r.id, err);
    const why = err instanceof Error ? err.message : String(err);
    taskStatus.error("reminder:error", { kind: "reminder", name: "Reminder", line: `Couldn't deliver: ${r.text}`, detail: why });
  };
  // One data directory, one scheduler + reminder loop (#800): a bean-core on this ~/.bean can
  // hold the same bean.db lease. Refused = standby with a notice; this host takes over (and starts
  // the sprout scheduler) once the holder quits or its heartbeat expires. Lost = stop, relaunch.
  let schedulerLeaseHeld = false;
  let startScheduler: (() => void) | undefined;
  let stopScheduler: (() => void) | undefined;
  const schedulerLease = holdSchedulerLease({
    file: db, label: deps.headless ? "bean-core" : "desktop app",
    onAcquired: () => {
      schedulerLeaseHeld = true;
      taskStatus.dismiss("scheduler:lease");
      startScheduler?.();
    },
    onBlocked: (by) => taskStatus.error("scheduler:lease", {
      kind: "routine", name: "Sprouts", line: "Sprouts and reminders paused: another Bean is scheduling",
      detail: `${by.label} runs the scheduler for this data directory. Bean takes over when it stops.`,
    }),
    onLost: (by) => {
      schedulerLeaseHeld = false;
      stopScheduler?.();
      taskStatus.error("scheduler:lease", {
        kind: "routine", name: "Sprouts", line: by ? "Sprouts and reminders stopped: another Bean took over" : "Sprouts and reminders stopped: couldn't renew the scheduler lease",
        detail: by
          ? `${by.label} took over the scheduler for this data directory. Relaunch Bean to resume here.`
          : "Bean couldn't write its scheduler heartbeat to bean.db before it expired. Relaunch Bean to resume.",
      });
      deps.headless?.onLeaseLost();
    },
  });
  deps.onQuit(() => schedulerLease.stop());
  startReminderLoop({
    dir, canRun: schedulerLease.held,
    untargeted: (r) => {
      void deliver({ body: r.text }, [deps.notification]).then((outcomes) => {
        for (const o of outcomes) if (!o.ok) reminderFailed(r, `${o.name}: ${o.error instanceof Error ? o.error.message : String(o.error)}`);
      });
    },
    failed: reminderFailed,
  });

  const cfgPath = configFile(dir);
  // ponytail: first launch has no ~/.bean yet — bootstrap an empty-key config so
  // loadConfig (which throws on missing file) has something to read instead of crashing.
  if (!existsSync(cfgPath)) await saveConfig(cfgPath, { openaiApiKey: "", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, reasoningEffort: "" });
  const cfg = await loadConfig(cfgPath, dir);
  const runtime = createRuntimeConfig(
    { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp, editorApp: cfg.editorApp, delegateCli: cfg.delegateCli, systemControls: cfg.systemControls, reasoningEffort: cfg.reasoningEffort, disabledClis: cfg.disabledClis, webSearch: cfg.webSearch, autoMemory: cfg.autoMemory, homeDiscordDm: cfg.homeDiscordDm, homeTeamsDm: cfg.homeTeamsDm, gitName: cfg.gitName, gitEmail: cfg.gitEmail },
    {
      makeConverse: makeOpenAIConverse,
      makeRankByMeaning: (key) => makeRankByMeaning(db, makeOpenAIEmbed(key)),
      saveConfigFile: (update) => saveConfig(cfgPath, update),
    },
  );
  const enabledClis = (): CliName[] => detectedClis().filter((cli) => !runtime.getDisabledClis().includes(cli));
  const actionTools = buildActionTools({ remindersFile: remindersFile(dir), dbFile: db, systemControls: () => runtime.getSystemControls() });

  // A configured project's path or Bean's scratch workspace — the only cwds a chat delegate,
  // live session or terminal may spawn in, whatever path the renderer sent.
  const projectAllowed = async (path: string): Promise<boolean> =>
    path === scratchDir(dir) || (await loadProjects(projectsFile(dir))).some((p) => p.path === path);
  const loadSkills = (): ReturnType<typeof loadLayeredSkills> => loadLayeredSkills(skillsDir(projectDir), skillsDir(dir));

  const delegateTasks = createDelegateTasks({
    resolvedPath,
    dir,
    scratchPath: scratchDir(dir),
    projectAllowed,
    // One resolver for the chat's delegates; routine steps resolve the same preference in core.
    resolveCli: (model, cli) => resolveDelegateSelection(cliModels, enabledClis(), cli ?? runtime.getDelegateCli(), model),
    skillBrowser: async (name) => (await loadSkills()).find((s) => s.name === name)?.browser === true,
    send: (event) => {
      if (event.type === "started") {
        taskStatus.upsert(event.taskId, {
          kind: "delegate", name: event.projectPath ? basename(event.projectPath) : "delegate",
          line: "Starting…", detail: event.instruction, startedAt: Date.now(), state: "running",
          ...(event.mountId ? { mountId: event.mountId } : {}),
        });
      } else if (event.type === "output") {
        const line = event.line.trim();
        if (line) taskStatus.upsert(event.taskId, { line });
      } else if (event.type === "done") taskStatus.finish(event.taskId, "done", "Done");
      else if (event.type === "failed") taskStatus.finish(event.taskId, "failed", event.message);
      else taskStatus.finish(event.taskId, "failed", "Stopped", false); // the user's own Stop isn't a failure to chase
      if (event.mountId) push(event.mountId, "delegate", event);
    },
    newId: () => randomUUID(),
  });

  const liveTasks = createLiveTasks({
    resolvedPath,
    dir,
    enabledClis,
    cliModels: () => cliModels,
    scratchPath: scratchDir(dir),
    findResumable: (sessionId) => findDelegateRun(db, sessionId, undefined, "desktop"),
    modelOffered: (cli, model) => (cliModels.find((e) => e.provider === cli)?.models ?? []).includes(model),
    projectAllowed,
    newId: () => randomUUID(),
    send: (event) => {
      const id = `live:${event.sessionId}`;
      if (event.type === "started") {
        taskStatus.upsert(id, {
          kind: "live", agent: event.agent, name: `${LIVE_AGENT_NAMES[event.agent]} · ${basename(event.projectPath) || "scratch"}`,
          line: "Starting…", detail: event.projectPath, startedAt: Date.now(), state: "running", mountId: event.mountId,
        });
      } else if (event.type === "output") {
        const line = event.line.trim();
        if (line) taskStatus.upsert(id, { line });
      } else if (event.type === "turn") {
        taskStatus.upsert(id, { line: event.interrupted ? "Turn stopped" : event.failed ? "Turn failed" : "Waiting for you" });
      } else if (event.type === "session" || event.type === "text" || event.type === "turn-start" || event.type === "consumed") {
        // the receipt and prose are for the chat window only
      } else if (event.reason === "failed") taskStatus.finish(id, "failed", event.error ?? "Session died");
      else taskStatus.finish(id, "done", event.reason === "stopped" ? "Session ended" : "Session ended on its own", false);
      push(event.mountId, "live", event);
    },
  });
  // Synchronous on purpose (see delegate-tasks.ts's interruptAll): no preventDefault-then-requeue.
  deps.onQuit(() => {
    delegateTasks.interruptAll();
    // Live agent sessions run permissions-bypassed in their own process groups: SIGKILL every
    // tree now (no outbox notice — the next boot's sweepDeadRuns clears their records silently).
    liveTasks.forceKillAll();
    // Delegates run in their own process group (detached) and would outlive us — routine steps
    // and builder agents included, and so do routine command steps. SIGKILL them now; cancel()'s
    // 5s escalation can't fire after exit.
    killAllDelegates();
    killAllCommands();
  });

  // --- Routines: cron-scheduled multi-step automations (see .memory/project-routines.md). ---
  const routinesPath = routinesDir(dir);
  // Run records a crash left behind (run-queue.ts). Never kills: the bots share runs/.
  sweepDeadRuns(dir);
  // User-facing saves (editor, builder) refuse a chat sink naming an unknown destination.
  const saveKnownSinks = async (r: Routine, models?: CliModels[]): Promise<void> => {
    const problem = sinkAliasProblems(r, listDestinations(db))[0];
    if (problem) throw new Error(problem);
    await saveRoutine(routinesPath, r, models);
  };
  const routineBubbles = createRoutineBubbles(taskStatus);
  // The avatar's Home bubble (#961); set once the chat threads exist (a post can't land before).
  let homeBubble: ReturnType<typeof createHomeBubble> | undefined;
  // Routine host + scheduler (core routine-wiring.ts), on the same resolved login-shell PATH
  // spawn as delegate-tasks (safety-packaged-app-path-detection).
  const routines = createRoutineWiring({
    dir,
    builtinDir: projectDir,
    converse: runtime.converse,
    rankByMeaning: runtime.rankByMeaning,
    getModel: () => runtime.getModel(),
    // ponytail: briefModel read at boot like imageModel; move into runtime-config if a Settings field ever exists
    getBriefModel: () => cfg.briefModel,
    clis: enabledClis,
    cliModels,
    getDelegateCli: () => runtime.getDelegateCli(),
    path: resolvedPath,
    spawnFn: resolvedPathSpawnFn(resolvedPath),
    tools: actionTools,
    onStatus: routineBubbles.onStatus,
    notify: async ({ target, home, ...msg }) => {
      const meta = home ? { open: "home" } : target ? { open: "dashboard", target } : undefined;
      if (deps.notification.available()) await deps.notification.send({ ...msg, ...(meta ? { meta } : {}) });
    },
    onHomePost: () => homeBubble?.refresh(),
    homeDms: () => runtime.getHomeDms(),
    canSchedule: () => schedulerLease.held() && !updating, // fails closed past the last good renewal
    alarm: (routine, error) => {
      if (deps.notification.available()) {
        void deps.notification.send({ title: `Sprout: ${routine.name}`, body: `Can't check for new items — ${error}`, meta: { open: "routines" } });
      }
    },
    // Headless: rebase each to its next slot (still no catch-up), or the scheduler's missed guard
    // would skip it forever.
    // A dispatch's result goes back where it was asked (#919); a desktop chat's loops back (#921).
    deliverDispatch: async (d) => {
      if (d.surface === "desktop") return deliverDesktopSprout?.(d) ?? false;
      await enqueueDispatchNotice(outboxDir(dir), { ...d, surface: d.surface });
      return true;
    },
    ...(deps.headless ? {
      onMissed: (names: string[]) => {
        void deps.notification.send({ body: missedNotice(names) });
        void routines.scheduler.clearMissed(names).catch((err: unknown) => console.error("bean: clearing missed routines failed", err));
      },
    } : {}),
  });
  const routineScheduler = routines.scheduler;
  const SPROUTS_STANDBY = "Sprouts are paused on this Bean — another Bean process runs them for this data directory.";
  // Set once the chat sessions exist; a sweep before then leaves desktop results owed.
  let deliverDesktopSprout: ((d: Dispatch) => boolean) | undefined;
  let threadsOfChat: ((mountKey: string) => string[]) | undefined;
  const triggerSprout = (name: string, action: "run" | "check", opts: Parameters<typeof routineScheduler.trigger>[2]) => {
    if (action !== "run") return routineScheduler.trigger(name, action);
    if (updating) return Promise.resolve({ status: "refused" as const, reason: UPDATING });
    // Busy until the admitted run finishes, not just until it is admitted.
    let finished: Promise<unknown> = Promise.resolve();
    const admitted = routineScheduler.trigger(name, action, opts).then((t) => { if (t.status === "started") finished = t.done; return t; });
    void track(admitted.then(() => finished)).catch(() => {});
    return admitted;
  };
  // Run now for one queued todo (#923): busy like a sprout run, until that run ends.
  const runTodoNow = (name: string, todoId: string): ReturnType<typeof routineScheduler.runTodo> => {
    if (updating) return Promise.resolve({ status: "refused" as const, reason: UPDATING });
    let finished: Promise<unknown> = Promise.resolve();
    const admitted = routineScheduler.runTodo(name, todoId).then((t) => { if (t.status === "started") finished = t.done; return t; });
    void track(admitted.then(() => finished)).catch(() => {});
    return admitted;
  };
  // A bot's sprout-run tap (#637). The host runs the scheduler, so it also records the dispatch and
  // posts the finish reply to the asking conversation, across a restart (#919). Lease holder only.
  const answerSproutTrigger = (bot: ChatopsSurface, req: RoutineTrigger): Promise<RoutineTriggerAnswer> => answerRoutineTrigger(req, {
    load: () => loadRoutines(routinesPath),
    facts: (r) => sproutRunFacts(db, r),
    held: schedulerLease.held,
    trigger: withDispatch(triggerSprout, { file: db, surface: bot, deliver: routines.deliverDispatches }),
    file: db,
    runTodo: runTodoNow,
  });
  // background_work's live counts (#924), for desktop chats and the bots: none on a standby host,
  // whose scheduler isn't the one running sprouts.
  const liveSprouts = (): { name: string; runs: number }[] | undefined => (schedulerLease.held()
    ? routineScheduler.runningNames().map((name) => ({ name, runs: routineScheduler.runningCount(name) }))
    : undefined);
  // A desktop chat's sprout card (#921): the same recorded dispatch, its origin the chat thread.
  const chatSproutTrigger = withDispatch(triggerSprout, { file: db, surface: "desktop", deliver: routines.deliverDispatches });
  const tools = detectTools(resolvedPath);
  const routineBuilder = createRoutineBuilder({
    loadRoutines: () => loadRoutines(routinesPath),
    saveRoutine: (r) => saveKnownSinks(r),
    loadSkills,
    saveSkill: (name, md) => saveSkill(skillsDir(dir), name, md),
    pollWatch: routines.pollWatch,
    fetchText,
    tools: () => tools,
    // Not recorded in delegate_runs: the builder is internal tooling whose scratch session the
    // user never asked to revisit (see .memory/project-delegate-session-receipts.md).
    startAgent: (prompt, brief, onLine) => {
      if (updating) return { done: Promise.reject(new Error(UPDATING)), cancel: () => {} };
      const choice = resolveDelegateSelection(cliModels, enabledClis(), brief.builder?.cli ?? runtime.getDelegateCli(), brief.builder?.model);
      if (!choice) return { done: Promise.reject(new Error("No enabled delegate CLI found — enable one in Settings.")), cancel: () => {} };
      const cwd = join(scratchDir(dir), `build-${brief.name}`); // name validated kebab-case in builder.start
      mkdirSync(cwd, { recursive: true });
      let cancel = (): void => {};
      // Busy until the agent's process is gone (no status job of its own) — a cancel never settles `done`.
      let untrack = (): void => {};
      void track(new Promise<void>((r) => { untrack = r; }));
      const done = new Promise<string>((resolve, reject) => {
        const cleanup = (): void => {
          untrack();
          rmSync(cwd, { recursive: true, force: true });
        };
        const handle = runDelegate(
          { cli: choice.cli, projectPath: cwd, prompt, ...(choice.model ? { model: choice.model } : {}) },
          { onOutput: onLine, onDone: (out) => { cleanup(); resolve(out); }, onError: (err) => { cleanup(); reject(err); } },
          resolvedPathSpawnFn(resolvedPath),
          ROUTINE_STEP_TIMEOUT_MS,
        );
        cancel = () => handle.cancel(cleanup);
      });
      return { done, cancel: () => cancel() };
    },
  });
  deps.onQuit(() => routineBuilder.cancelAll());
  // Started by whichever comes second: this line, or the lease being acquired (standby). Only
  // the lease holder recovers todos: anything stuck `running` was interrupted by the previous
  // holder (quit/crash) — fail it visibly (retryable). A standby host must not touch them: the
  // current holder is still running them.
  // The lease holder also runs the one-conversation cutover (#999): it holds the API key in remote
  // setups. A failure, a source written mid-fold, or a Home open meanwhile (it runs on the shell's
  // history until reopened) leaves everything dark; the next boot retries.
  let homeHolder: (() => string | undefined) | undefined; // wired once the thread handlers exist
  const cutover = (): void => {
    if (mainCutover(db)) return;
    void loadChatopsOwners(dir)
      .then((owners) => runMainCutover(db, owners, { chat: runtime.converse, model: runtime.getModel() }, {
        inUse: () => homeHolder?.() !== undefined,
      }))
      .then((r) => { if (r === "changed") console.warn("bean: main conversation cutover deferred to the next boot: Home was open or a history changed mid-fold"); })
      .catch((err: unknown) => console.error("bean: main conversation cutover failed", err));
  };
  // Owner-DM sinks fold into Home on load (#1068); once per data dir the surfaces they named get
  // their "Home posts also go to this DM" toggle. Called first: it reads the raw sprout files
  // synchronously, before a scheduler tick can re-save one already folded.
  // A failed config write is told to the owner with the keys to set by hand: the retry at the next
  // lease take is best-effort (a sprout saved meanwhile no longer names its owner DM on disk).
  const migrateHomeDms = (): void => {
    void migrateOwnerDmSinks(routinesPath, db, (ts) => runtime.apply({
      ...(ts.includes("discord") ? { homeDiscordDm: true } : {}),
      ...(ts.includes("teams") ? { homeTeamsDm: true } : {}),
    }).catch((err: unknown) => {
      const keys = ts.map((t) => `"${t === "discord" ? "homeDiscordDm" : "homeTeamsDm"}": true`).join(" and ");
      void deliver({
        title: "Sprouts now post to your chat with Bean",
        body: `Sprouts that DMed you now post to your chat with Bean, but turning on their phone copy failed (${err instanceof Error ? err.message : String(err)}). Set ${keys} in config.json to keep getting them in your DM.`,
      }, [deps.notification]);
      throw err;
    })).catch((err: unknown) => console.error("bean: owner-DM sink migration failed; retried at the next lease take", err));
  };
  startScheduler = () => { migrateHomeDms(); void routines.start(); cutover(); };
  stopScheduler = () => routineScheduler.stop();
  if (schedulerLeaseHeld) startScheduler();
  deps.onQuit(() => routineScheduler.stop());

  // Checked after each auto-save (close batch or per-turn capture) — no timer, no boot cost.
  // The digest goes to a bubble + Persona only, never into a transcript (it would be
  // re-extracted as a "fact").
  const checkDream = async (pendingIds: () => string[]): Promise<void> => {
    const dream = await maybeDream({ dbFile: db, chat: runtime.converse, model: runtime.getModel(), exclude: pendingIds });
    if (!dream) return;
    const parts = [
      dream.merged ? `merged ${dream.merged}` : "", dream.rewritten ? `rewrote ${dream.rewritten}` : "",
      dream.removed ? `removed ${dream.removed}` : "",
    ].filter(Boolean).join(", ");
    taskStatus.upsert("memory:dream", { kind: "memory", name: "Memory", startedAt: Date.now(), state: "running" });
    taskStatus.finish("memory:dream", "done", `🌙 Tidied memory: ${parts} · click to review`);
  };
  const sourceLabels = (): Map<string, string> => {
    const rows = listDestinations(db);
    return new Map(rows.flatMap((r): [string, string][] => {
      const label = destinationLabel(r, rows);
      return label ? [[`${r.surface}:${r.conversationId}`, label]] : [];
    }));
  };
  const memory = buildMemoryHandlers({
    loadMemories, appendMemories, updateMemory, updateMemoryCategory, renameMemoryCategory, deleteMemories, extractMemories,
    restoreDreamRun, dreamDetails, loadProjects,
    ownerSubjectIds: () => ownerSubjectIds(db, dir),
    sourceLabels,
    getLastDream: async (file) => (await getMemoryMeta(file, "lastDream")) as DreamDigest | undefined,
    autoMemory: () => runtime.getAutoMemory(),
    converse: runtime.converse,
    getModel: runtime.getModel,
    dbFile: db,
    projectsFile: projectsFile(dir),
    onTurnBatch: (pendingIds) => {
      checkDream(pendingIds).catch((err) => console.error("memory dream failed:", err));
    },
    onMemoryBatch: (batch, pendingIds) => {
      void (async () => {
        const first = await deps.firstAutoMemory();
        const id = "memory:batch";
        taskStatus.upsert(id, { kind: "memory", name: "Memory", startedAt: Date.now(), state: "running" });
        taskStatus.finish(id, "done", first
          ? "I remember things automatically now · click to review or turn off"
          : `🧠 Remembered ${batch.length} · click to review`);
        await checkDream(pendingIds);
      })().catch((err) => console.error("memory bubble/dream failed:", err));
    },
    onMemoryFailure: () => taskStatus.error("memory:error", { kind: "memory", name: "Memory", line: "Couldn't update memory" }),
  });

  const sends = buildSendHandlers({
    dbFile: db, listDestinations: (file) => listDestinations(file), destinationLabel, matchDestination,
    enqueue: (msg) => enqueueOutbox(outboxDir(dir), msg, randomUUID), newId: randomUUID,
  });
  // propose_routine's desktop card (#982). Saves go through the Sprouts panel's own save (bound late:
  // `handlers` is built below) so restore, rebase and the per-sprout lane apply the same way.
  const routineDrafts = buildRoutineDraftHandlers({
    loadRoutines: () => loadRoutines(routinesPath),
    save: (r) => handlers.routines.save(r),
    enableWatch: (name, until) => routineScheduler.enableWatch(name, false, until),
    cliModels: () => cliModels, destinations: () => listDestinations(db), newId: randomUUID,
    personaName: () => loadPersonaNameSync(personaFile(dir), personaFile(projectDir)),
  });
  // The running turn per chat (mount id), so image progress can find its bubble.
  const chatTurnIds = new Map<string, string>();
  const paths = {
    loadSkills: loadLayeredSkills, loadProjects, loadPersona, saveProjects, saveSkill, deleteSkill, savePersona,
    projectSkillsDir: skillsDir(projectDir), skillsDir: skillsDir(dir), projectsFile: projectsFile(dir),
    personaFile: personaFile(dir), projectPersonaFile: personaFile(projectDir), dbFile: db,
  };
  // The main conversation's log (#997): read per request, so the cutover (#999) switches it on live.
  let mainStore: ConversationStore | undefined;
  const mainLog = (): ConversationStore | undefined => {
    if (!mainCutover(db)) return undefined;
    return (mainStore ??= new ConversationStore(db));
  };
  const chat = buildChatHandler({
    ...paths,
    // `threads` is built just below; a turn only runs after both exist.
    mainLog: (mountId) => (mountId !== undefined && threads.isMain(mountId) ? mainLog() : undefined),
    loadMemories, appendMemories, deleteMemories,
    ownerSubjectIds: () => ownerSubjectIds(db, dir),
    converse: runtime.converse,
    rankByMeaning: runtime.rankByMeaning,
    getModel: runtime.getModel,
    actions: actionTools,
    beanDirPath: dir,
    delegateAvailable: () => enabledClis().length > 0,
    // A live CLI is enabled and this chat could open a session now (#478, cap #517).
    liveSessionAvailable: (clientId, mountId) => isChatClient(clientId)
      && enabledClis().some(isLiveCli) && liveTasks.canStart({ clientId, mountId }),
    webSearch: () => runtime.getWebSearch(),
    // A remote shell has no Terminal.app of ours to hand off to (#812): terminal skills become delegates.
    runAvailable: (clientId) => !attachments.isClient(clientId),
    loadRoutines: () => loadRoutines(routinesPath),
    sproutFacts: (r) => sproutRunFacts(db, r),
    todoAhead: (r) => pendingTodoCount(db, r),
    backgroundWork: { stateFile: routineStateFile(dir), running: liveSprouts, threadsOf: (k) => threadsOfChat?.(k) ?? [] },
    proposeSend: sends.propose,
    // Local chats only: a remote shell has no Sprouts panel to save or edit into.
    routineDrafts: (clientId) => (attachments.isClient(clientId) ? undefined : routineDrafts),
    imageGen: {
      generate: (a) => makeOpenAIImageGen(runtime.getApiKey())(a),
      // ponytail: imageModel read at boot; move into runtime-config if a Settings field ever exists
      getModel: () => cfg.imageModel,
      imagesDir: imagesDir(dir),
      saveNoteImage: (bytes) => saveNoteImage(db, bytes),
      onStart: (mountId) => {
        if (mountId !== undefined) push(mountId, "imageProgress", mountId);
        const turnId = mountId === undefined ? undefined : chatTurnIds.get(mountId);
        if (turnId) taskStatus.upsert(turnId, { line: "Drawing an image…" });
      },
    },
  });
  // Desktop chat history: per-chat thread pins and incognito latches.
  const threads = buildChatThreadHandlers({
    dbFile: db, saveDesktopChat, getDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats,
    renameDesktopChatGroup, listDesktopChats, listPendingHomePosts: (file) => listPendingHomePosts(file), saveDesktopChatDraining,
    mainLog,
    onDrained: () => homeBubble?.refresh(),
    personaName: () => loadPersonaNameSync(personaFile(dir), personaFile(projectDir)),
  });
  homeHolder = () => threads.holderOf(HOME_THREAD_ID);
  homeBubble = createHomeBubble({
    count: () => countPendingHomePosts(db),
    nextExpiry: () => nextHomePostExpiry(db),
    name: () => loadPersonaNameSync(personaFile(dir), personaFile(projectDir)),
    status: taskStatus,
  });
  homeBubble.refresh(); // boot: posts left pending bring the bubble back
  deps.onQuit(() => homeBubble?.stop());
  const sessions = createChatSessions({
    isChatClient, chat, memory, threads, delegateTasks, liveTasks, push,
    onRelease: deps.onChatRelease,
    refuseStart,
    track,
    // Lease holder only, like a bot's tap: the holder's start closes any other host's open dispatch.
    sproutRun: (name, origin) => (schedulerLease.held()
      ? chatSproutTrigger(name, "run", origin)
      : Promise.resolve({ status: "refused" as const, reason: SPROUTS_STANDBY })),
    // A todo card's Run now / Queue (#923): queued with its dispatch (any host may — the row follows a
    // pending todo), then Run now asks this host's scheduler, lease holder only.
    todoDispatch: async (todo, mode, origin) => {
      resolveTodoRoutine(await loadRoutines(routinesPath), todo.routine); // throws a user-facing reason
      const q = queueTodoDispatch(db, { ...todo, ...(mode === "run" ? { front: true } : {}) }, {
        surface: "desktop", conversation: origin.channel, ...(origin.keepBrief === false ? { keepBrief: false } : {}),
      });
      if (mode === "queue") return { jobId: q.jobId, outcome: "queued" as const, ahead: q.ahead };
      const a = await answerTodoRun(q.jobId, { file: db, held: schedulerLease.held, runTodo: runTodoNow });
      return a.status === "started" ? { jobId: q.jobId, outcome: "running" as const }
        : a.status === "next" ? { jobId: q.jobId, outcome: "next" as const }
        : { jobId: q.jobId, outcome: "queued" as const, ahead: 0, reason: a.status === "refused" && a.reason === "standby" ? SPROUTS_STANDBY : "It couldn't start now" };
    },
    sproutOutcomes: (thread) => threadDispatches(db, thread).map((d) => {
      if (d.status === undefined) return { jobId: d.id };
      markDispatchDelivered(db, d.id);
      return { jobId: d.id, status: d.status, text: dispatchContext(d) };
    }),
    onChatTurn: (mountId) => {
      const id = `chat:${randomUUID()}`;
      chatTurnIds.set(mountId, id);
      taskStatus.upsert(id, { kind: "chat", name: "Chat", line: "Thinking…", startedAt: Date.now(), state: "running" });
      return (error) => {
        if (chatTurnIds.get(mountId) === id) chatTurnIds.delete(mountId);
        // The reply is already in the chat window — a done bubble would only echo it.
        taskStatus.dismiss(id);
        if (error) taskStatus.error("chat:error", { kind: "chat", name: "Chat", line: error, detail: error });
      };
    },
  });

  deliverDesktopSprout = sessions.deliverSprout;
  threadsOfChat = sessions.threadsOf;

  const getConfig = (): ConfigView => ({
    openaiApiKey: runtime.getApiKey(),
    model: runtime.getModel(),
    terminalApp: runtime.getTerminalApp(),
    editorApp: runtime.getEditorApp(),
    delegateCli: runtime.getDelegateCli(),
    systemControls: runtime.getSystemControls(),
    reasoningEffort: runtime.getReasoningEffort(),
    disabledClis: runtime.getDisabledClis(),
    webSearch: runtime.getWebSearch(),
    autoMemory: runtime.getAutoMemory(),
    homeDiscordDm: runtime.getHomeDms().discord,
    homeTeamsDm: runtime.getHomeDms().teams,
    gitName: runtime.getGitName(),
    gitEmail: runtime.getGitEmail(),
    apiKeySet: runtime.getApiKey() !== "",
    paths: { config: cfgPath, skills: skillsDir(dir), projects: projectsFile(dir), persona: personaFile(dir) },
  });

  const personaHandlers = buildPersonaHandlers(paths);
  const handlers = {
    chat: sessions,
    threads,
    memory,
    notes: buildNotesHandlers({ loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote, loadNoteHistory, saveNoteImage, loadNoteImage, dbFile: db }),
    // A rename re-labels the avatar's bubble now, not at its next recount (#1001).
    persona: {
      ...personaHandlers,
      save: async (persona: Parameters<typeof personaHandlers.save>[0]): Promise<void> => {
        await personaHandlers.save(persona);
        homeBubble?.refresh();
      },
    },
    listSkills: buildListSkillsHandler({ ...paths, loadRoutines: () => loadRoutines(routinesPath, true) }),
    saveSkill: buildSaveSkillHandler(paths),
    deleteSkill: buildDeleteSkillHandler(paths),
    listProjects: buildListProjectsHandler(paths),
    saveProjects: buildSaveProjectsHandler(paths),
    models: buildModelsHandler({ getAvailableClis: enabledClis, getCliModels: () => cliModels, reload: clisWatch.reload }),
    modelMemory: buildModelMemoryHandlers({ loadModelMemory, saveModelMemory, modelMemoryFile: modelMemoryFile(dir) }),
    sends,
    routineDrafts,
    skillProposals: buildSkillProposalHandlers({ loadSkills: loadLayeredSkills, projectSkillsDir: skillsDir(projectDir), skillsDir: skillsDir(dir), dbFile: db }),
    routines: buildRoutineHandlers({
      loadRoutines: () => loadRoutines(routinesPath),
      // Model check only when enabling/enabled: pausing must never be blocked by a model that
      // has since left clis.json (the run itself refuses either way).
      saveRoutine: (r) => saveKnownSinks(r, r.enabled ? cliModels : undefined),
      deleteRoutine: (name) => deleteRoutine(routinesPath, name),
      loadStates: () => loadRoutineStates(routineStateFile(dir)),
      isRunning: (name) => routineScheduler.isRunning(name),
      runningCount: (name) => routineScheduler.runningCount(name),
      withSprout: routineScheduler.withSprout,
      rebase: (name) => routineScheduler.rebase(name),
      queueCounts: async (name) => {
        const todos = await listTodos(db, name);
        return { pending: todos.filter((t) => t.status === "pending").length, running: todos.filter((t) => t.status === "running").length };
      },
      runNow: (name) => (updating ? Promise.resolve({ started: false, reason: UPDATING }) : track(routineScheduler.runNow(name))),
      stopRuns: (name) => {
        routineBubbles.stopping(name);
        routineScheduler.stopRuns(name);
      },
      onRoutineDeleted: async (name) => {
        await deleteTodosForRoutine(db, name);
        clearWatch(db, name);
        pruneStepAttempts(db, name, []);
      },
      attempts: (runId) => listStepAttempts(db, runId).map((a) => ({
        stepIndex: a.stepIndex, round: a.round, kind: a.kind, ok: a.ok, output: a.output,
        ...(a.stepId ? { stepId: a.stepId } : {}), ...(a.cli ? { cli: a.cli } : {}), ...(a.verdict ? { verdict: a.verdict } : {}),
        ...(a.cli && a.sessionId && isValidSessionId(a.sessionId) && CLI_NAMES.includes(a.cli as CliName)
          ? { resume: resumeCommand(a.cli as CliName, a.sessionId) } : {}),
      })),
      watch: {
        isSeeded: (r) => (r.watch ? isWatchSeeded(db, r.name, watchSourceKey(r.watch)) : true),
        pollFailures: (name) => routineScheduler.pollFailures(name),
        checkNow: (name) => routineScheduler.checkNow(name),
        previewWatch: routines.pollWatch,
        enableWatch: (name, queueExisting, until) => routineScheduler.enableWatch(name, queueExisting, until),
        sinkRecipients: () => sinkRecipients(dir),
        draftBrief: async (sentence, previous) => {
          const [skills, projects] = await Promise.all([loadSkills(), loadProjects(projectsFile(dir))]);
          const ctx = {
            tools,
            projects: projects.map((p) => ({ name: p.name, path: p.path })),
            skills: skills.filter((s) => !s.hidden && s.enabled !== false).map((s) => ({ name: s.name, description: s.description })),
            clis: enabledClis(),
          };
          // Plain structured-output call on /v1/responses with no tools — not a propose_* tool,
          // so converse()'s byte-stable tool list is untouched.
          const res = await runtime.converse({ model: runtime.getModel(), messages: briefMessages(sentence, ctx, previous), tools: [] });
          return { brief: parseBrief(res.content, ctx), tools };
        },
        builds: routineBuilder,
      },
    }),
    todos: buildTodoHandlers({
      dbFile: db,
      loadRoutines: () => loadRoutines(routinesPath),
      addTodo, listTodos, listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo,
      withSprout: routineScheduler.withSprout,
    }),
    destinations: buildDestinationHandlers({
      dbFile: db,
      loadRoutines: () => loadRoutines(routinesPath),
      saveRoutine: (r) => saveRoutine(routinesPath, r),
      owners: () => loadChatopsOwners(dir),
      listDestinations: (file) => listDestinations(file), destinationLabel, ambientSpeakers: (file, id) => ambientSpeakers(file, id),
      setAlias, clearAlias, retargetAlias,
    }),
    getConfig,
    applyConfig: runtime.apply,
    getModel: runtime.getModel,
    availableClis: enabledClis,
    detectedClis,
    cancelDelegate: delegateTasks.cancel,
    dismissTask: taskStatus.dismiss,
    /** Today's pending Home posts (#961): a remote shell's bubble and dot poll this. */
    homePending: (): number => countPendingHomePosts(db),
    /** A chat's live-session project (mount key) — what a relative Cmd+click path resolves against. */
    liveProjectOf: liveTasks.projectOf,
  };

  // Last: a replayed autostart may answer a sprout tap at once, so the scheduler must exist.
  const bots = await startBots({
    ...deps.bots,
    // A bot wrote the main log (#998): a text-free ping to the chat holding Home on it, which pulls
    // the owner's DM rows (#1000) — over SSH too. Not a sidebar row, so never a synced-chat event.
    onSynced: (e) => {
      if (e.conversationId !== MAIN_CONVERSATION_ID) { deps.bots.onSynced(e); return; }
      const home = threads.holderOf(HOME_THREAD_ID);
      if (home !== undefined && threads.isMain(home)) push(home, "main", home);
    },
    dir, builtinDir: projectDir, resolvedPath, taskStatus, onQuit: deps.onQuit, onRoutineTrigger: answerSproutTrigger,
    onRoutineRunning: liveSprouts,
  });
  // The owner's daily memory digest (#859): under the scheduler lease, to every bot running now.
  deps.onQuit(startMemoryDigest({
    dbFile: db, canRun: schedulerLease.held, ownerIds: () => ownerSubjectIds(db, dir), labels: sourceLabels,
    runningBots: () => (["discord", "teams"] as const).filter((b) => bots.status()[b].running),
    enqueue: (msg) => enqueueOutbox(outboxDir(dir), msg, randomUUID),
  }));

  return {
    handlers,
    taskStatus,
    runtime,
    resolvedPath,
    cliModels,
    enabledClis,
    projectAllowed,
    delegateTasks,
    liveTasks,
    attachments,
    schedulerLease,
    bots,
    coreUpdate: {
      close: () => { updating = true; },
      open: () => { updating = false; },
      busy: () => [
        ...busyWork(taskStatus.list(), liveRuns(dir), routineScheduler.runningNames()),
        ...(pendingStarts > 0 ? [{ kind: "request", name: `${pendingStarts} start request(s) in progress` }] : []),
      ],
    } satisfies CoreLatch,
  };
}

export type Host = Awaited<ReturnType<typeof createHost>>;
export type HostHandlers = Host["handlers"];
