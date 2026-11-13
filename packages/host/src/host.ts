import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  configFile, projectsFile, skillsDir, personaFile, dbFile, remindersFile, modelMemoryFile, clisFile, routinesDir, routineStateFile, outboxDir,
  scratchDir, imagesDir, isValidSessionId, resumeCommand, pruneStepAttempts, listStepAttempts, CLI_NAMES, loadCliModels,
  loadConfig, saveConfig, loadLayeredSkills, loadProjects, saveProjects, saveSkill, deleteSkill, loadPersona, savePersona,
  makeOpenAIConverse, makeOpenAIImageGen, loadMemories, appendMemories, updateMemory, updateMemoryCategory, renameMemoryCategory,
  deleteMemories, extractMemories, maybeDream, getMemoryMeta, restoreDreamRun, dreamDetails, holdSchedulerLease, enqueueOutbox,
  answerRoutineTrigger, sproutRunFacts, withFinishReply, loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote,
  loadNoteHistory, saveNoteImage, loadNoteImage, detectClis, loginShellPath, resolveCliPath, deliver, loadRoutines, saveRoutine,
  deleteRoutine, loadRoutineStates, runDelegate, killAllDelegates, killAllCommands, ROUTINE_STEP_TIMEOUT_MS, addTodo, listTodos,
  listAllTodos, editTodoText, deleteTodo, reorderTodo, clearFinishedTodos, retryTodo, deleteTodosForRoutine, sweepDeadRuns,
  isWatchSeeded, clearWatch, watchSourceKey, briefMessages, parseBrief, isLiveCli, findDelegateRun, saveDesktopChat, getDesktopChat,
  deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats, renameDesktopChatGroup, listDesktopChats, detectTools,
  fetchText, createRoutineWiring, startReminderLoop, sinkRecipients, ownerSubjectIds, listDestinations, destinationLabel,
  matchDestination, ambientSpeakers, setAlias, clearAlias, retargetAlias, sinkAliasProblems, loadChatopsOwners, loadModelMemory,
  saveModelMemory, resolveDelegateSelection,
  type CliModels, type CliName, type ChatopsSurface, type DreamDigest, type Reminder, type Routine, type RoutineTrigger,
  type RoutineTriggerAnswer, type Transport,
} from "@bean/core";
import { buildActionTools } from "./action-tools.js";
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
import { startBots, type HostBotsOptions } from "./bots.js";
import { buildNotesHandlers } from "./notes.js";
import { createRoutineBuilder } from "./routine-builder.js";
import { buildRoutineHandlers } from "./routines.js";
import type { ClientId, HostPush } from "./shell-ops.js";
import { createRoutineBubbles, createTaskStatus, type TaskJob } from "./task-status.js";
import { createRuntimeConfig } from "./runtime-config.js";

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
}

/** The Electron-free host: the stateful registries (chat mounts and turns, delegates, live sessions,
 * status bubbles, runtime config, routine builder), the scheduler lease, the reminder loop, the
 * sprout scheduler, the Discord and Teams bots, and every handler the shell's IPC adapter wires to a
 * channel. Throws when the config can't load. */
export async function createHost(deps: HostDeps) {
  const { dir, builtinDir: projectDir } = deps;
  const db = dbFile(dir);
  // What Bean is working on, and what failed (design 2a).
  const taskStatus = createTaskStatus(deps.onJobs);

  // Finder-launched Electron gets a minimal PATH missing whatever the user's shell profile
  // adds (nvm, npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real
  // PATH once. CLI detection is re-scanned per resolution (cheap sync stat) so a CLI
  // installed after boot is picked up without a relaunch.
  const resolvedPath = resolveCliPath(process.env.PATH ?? "", loginShellPath(), homedir());
  const detectedClis = (): CliName[] => detectClis(resolvedPath);
  // Same repo-default + ~/.bean override layering as skills/persona; loaded once at boot
  // (no live reload — restart Bean after editing clis.json).
  const cliModels: CliModels[] = await loadCliModels(clisFile(projectDir), clisFile(dir));

  // Chatops reminders (a `target`) go to the outbox for their bot (Discord / Teams) to deliver; untargeted
  // ones stay desktop notifications.
  const reminderFailed = (r: Reminder, err: unknown): void => {
    console.error("bean: reminder delivery failed", r.id, err);
    const why = err instanceof Error ? err.message : String(err);
    taskStatus.error("reminder:error", { kind: "reminder", name: "Reminder", line: `Couldn't deliver: ${r.text}`, detail: why });
  };
  // One data directory, one scheduler + reminder loop (#800): a headless bot on this ~/.bean can
  // hold the same bean.db lease. Refused = standby with a notice; this host takes over (and starts
  // the sprout scheduler) once the holder quits or its heartbeat expires. Lost = stop, relaunch.
  let schedulerLeaseHeld = false;
  let startScheduler: (() => void) | undefined;
  let stopScheduler: (() => void) | undefined;
  const schedulerLease = holdSchedulerLease({
    file: db, label: "desktop app",
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
    { openaiApiKey: cfg.openaiApiKey, model: cfg.model, terminalApp: cfg.terminalApp, editorApp: cfg.editorApp, delegateCli: cfg.delegateCli, systemControls: cfg.systemControls, reasoningEffort: cfg.reasoningEffort, routineDigestContext: cfg.routineDigestContext, disabledClis: cfg.disabledClis, webSearch: cfg.webSearch, autoMemory: cfg.autoMemory },
    { makeConverse: makeOpenAIConverse, saveConfigFile: (update) => saveConfig(cfgPath, update) },
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
      if (event.mountId) deps.push(event.mountId, "delegate", event);
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
      deps.push(event.mountId, "live", event);
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
  // Routine host + scheduler (core routine-wiring.ts), on the same resolved login-shell PATH
  // spawn as delegate-tasks (safety-packaged-app-path-detection).
  const routines = createRoutineWiring({
    dir,
    builtinDir: projectDir,
    converse: runtime.converse,
    getModel: () => runtime.getModel(),
    clis: enabledClis,
    cliModels,
    getDelegateCli: () => runtime.getDelegateCli(),
    path: resolvedPath,
    spawnFn: resolvedPathSpawnFn(resolvedPath),
    tools: actionTools,
    getRoutineDigestContext: () => runtime.getRoutineDigestContext(),
    onStatus: routineBubbles.onStatus,
    notify: async ({ target, ...msg }) => {
      if (deps.notification.available()) await deps.notification.send({ ...msg, ...(target ? { meta: { open: "dashboard", target } } : {}) });
    },
    canSchedule: schedulerLease.held, // fails closed past the last good renewal
    alarm: (routine, error) => {
      if (deps.notification.available()) {
        void deps.notification.send({ title: `Sprout: ${routine.name}`, body: `Can't check for new items — ${error}`, meta: { open: "routines" } });
      }
    },
  });
  const routineScheduler = routines.scheduler;
  // A bot's sprout-run tap (#637). The host runs the scheduler, so it also posts the finish reply,
  // to the asking conversation.
  const answerSproutTrigger = (bot: ChatopsSurface, req: RoutineTrigger): Promise<RoutineTriggerAnswer> => answerRoutineTrigger(req, {
    load: () => loadRoutines(routinesPath),
    facts: (r) => sproutRunFacts(db, r),
    trigger: withFinishReply(routineScheduler.trigger, (msg) => enqueueOutbox(outboxDir(dir), { transport: bot, ...msg }, randomUUID)),
  });
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
      const choice = resolveDelegateSelection(cliModels, enabledClis(), brief.builder?.cli ?? runtime.getDelegateCli(), brief.builder?.model);
      if (!choice) return { done: Promise.reject(new Error("No enabled delegate CLI found — enable one in Settings.")), cancel: () => {} };
      const cwd = join(scratchDir(dir), `build-${brief.name}`); // name validated kebab-case in builder.start
      mkdirSync(cwd, { recursive: true });
      let cancel = (): void => {};
      const done = new Promise<string>((resolve, reject) => {
        const cleanup = (): void => rmSync(cwd, { recursive: true, force: true });
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
  startScheduler = () => { void routines.start(); };
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
  const memory = buildMemoryHandlers({
    loadMemories, appendMemories, updateMemory, updateMemoryCategory, renameMemoryCategory, deleteMemories, extractMemories,
    restoreDreamRun, dreamDetails, loadProjects,
    ownerSubjectIds: () => ownerSubjectIds(db, dir),
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
  // The running turn per chat (mount id), so image progress can find its bubble.
  const chatTurnIds = new Map<string, string>();
  const paths = {
    loadSkills: loadLayeredSkills, loadProjects, loadPersona, saveProjects, saveSkill, deleteSkill, savePersona,
    projectSkillsDir: skillsDir(projectDir), skillsDir: skillsDir(dir), projectsFile: projectsFile(dir),
    personaFile: personaFile(dir), projectPersonaFile: personaFile(projectDir), dbFile: db,
  };
  const chat = buildChatHandler({
    ...paths,
    loadMemories, appendMemories, deleteMemories,
    ownerSubjectIds: () => ownerSubjectIds(db, dir),
    converse: runtime.converse,
    getModel: runtime.getModel,
    actions: actionTools,
    beanDirPath: dir,
    delegateAvailable: () => enabledClis().length > 0,
    // A live CLI is enabled and this chat could open a session now (#478, cap #517).
    liveSessionAvailable: (clientId, mountId) => deps.isChatClient(clientId)
      && enabledClis().some(isLiveCli) && liveTasks.canStart({ clientId, mountId }),
    webSearch: () => runtime.getWebSearch(),
    loadRoutines: () => loadRoutines(routinesPath),
    sproutFacts: (r) => sproutRunFacts(db, r),
    proposeSend: sends.propose,
    imageGen: {
      generate: (a) => makeOpenAIImageGen(runtime.getApiKey())(a),
      // ponytail: imageModel read at boot; move into runtime-config if a Settings field ever exists
      getModel: () => cfg.imageModel,
      imagesDir: imagesDir(dir),
      saveNoteImage: (bytes) => saveNoteImage(db, bytes),
      onStart: (mountId) => {
        if (mountId !== undefined) deps.push(mountId, "imageProgress", mountId);
        const turnId = mountId === undefined ? undefined : chatTurnIds.get(mountId);
        if (turnId) taskStatus.upsert(turnId, { line: "Drawing an image…" });
      },
    },
  });
  // Desktop chat history: per-chat thread pins and incognito latches.
  const threads = buildChatThreadHandlers({
    dbFile: db, saveDesktopChat, getDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats,
    renameDesktopChatGroup, listDesktopChats,
  });
  const sessions = createChatSessions({
    isChatClient: deps.isChatClient, chat, memory, threads, delegateTasks, liveTasks, push: deps.push,
    onRelease: deps.onChatRelease,
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

  const getConfig = (): ConfigView => ({
    openaiApiKey: runtime.getApiKey(),
    model: runtime.getModel(),
    terminalApp: runtime.getTerminalApp(),
    editorApp: runtime.getEditorApp(),
    delegateCli: runtime.getDelegateCli(),
    systemControls: runtime.getSystemControls(),
    reasoningEffort: runtime.getReasoningEffort(),
    routineDigestContext: runtime.getRoutineDigestContext(),
    disabledClis: runtime.getDisabledClis(),
    webSearch: runtime.getWebSearch(),
    autoMemory: runtime.getAutoMemory(),
    paths: { config: cfgPath, skills: skillsDir(dir), projects: projectsFile(dir), persona: personaFile(dir) },
  });

  const handlers = {
    chat: sessions,
    threads,
    memory,
    notes: buildNotesHandlers({ loadNotes, saveNote, archiveNote, restoreNote, purgeNote, starNote, loadNoteHistory, saveNoteImage, loadNoteImage, dbFile: db }),
    persona: buildPersonaHandlers(paths),
    listSkills: buildListSkillsHandler(paths),
    saveSkill: buildSaveSkillHandler(paths),
    deleteSkill: buildDeleteSkillHandler(paths),
    listProjects: buildListProjectsHandler(paths),
    saveProjects: buildSaveProjectsHandler(paths),
    models: buildModelsHandler({ getAvailableClis: enabledClis, getCliModels: () => cliModels }),
    modelMemory: buildModelMemoryHandlers({ loadModelMemory, saveModelMemory, modelMemoryFile: modelMemoryFile(dir) }),
    sends,
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
      queueCounts: async (name) => {
        const todos = await listTodos(db, name);
        return { pending: todos.filter((t) => t.status === "pending").length, running: todos.filter((t) => t.status === "running").length };
      },
      runNow: (name) => routineScheduler.runNow(name),
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
        enableWatch: (name, queueExisting) => routineScheduler.enableWatch(name, queueExisting),
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
    /** A chat's live-session project (mount key) — what a relative Cmd+click path resolves against. */
    liveProjectOf: liveTasks.projectOf,
  };

  // Last: a replayed autostart may answer a sprout tap at once, so the scheduler must exist.
  const bots = await startBots({
    ...deps.bots, dir, builtinDir: projectDir, resolvedPath, taskStatus, onQuit: deps.onQuit, onRoutineTrigger: answerSproutTrigger,
  });

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
    schedulerLease,
    bots,
  };
}

export type Host = Awaited<ReturnType<typeof createHost>>;
export type HostHandlers = Host["handlers"];
