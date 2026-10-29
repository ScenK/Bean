import { spawn } from "node:child_process";
import {
  runDelegate, recordRun, releaseRun, updateRunPid, enqueueOutbox, outboxDir, dbFile,
  interruptedRunNotice, BEAN_GIT_IDENTITY,
  isValidSessionId, isLiveSessionId, isLiveCli, recordDelegateSession, resumeCommand, shQuote, spawnEnv,
} from "@bean/core";
import type { CliModelSelection, CliName, LiveCli, DelegateCallbacks, DelegateHandle, DelegateRequest, DelegateSpawnFn } from "@bean/core";

/** The started CLI session, for the delegate card's Copy chip: `label` is `claude · 3f2a…`,
 * `command` is `cd '<projectPath>' && claude --resume <id>`. Never put into chat text.
 * `sessionId` + `agent` are set only when the card may offer Continue live (a live CLI with its id
 * shape); the id is opaque to the renderer, which hands it back and main re-checks everything. */
export interface DelegateReceipt { label: string; command: string; sessionId?: string; agent?: LiveCli }

export type DelegateEvent =
  // projectPath/instruction label the avatar's status bubble (task-status.ts); chat ignores them.
  | { taskId: string; type: "started"; projectPath: string; instruction: string }
  | { taskId: string; type: "output"; line: string }
  | { taskId: string; type: "done"; result: string; receipt?: DelegateReceipt }
  | { taskId: string; type: "failed"; message: string; receipt?: DelegateReceipt }
  | { taskId: string; type: "cancelled"; receipt?: DelegateReceipt };

export interface DelegateStartRequest {
  projectPath: string;
  prompt: string;
  // ProposedDelegate.instruction — can be a full multi-step composed prompt, not just a short
  // label. Carried only for reporting an interrupted run back to chat after a restart (see
  // interruptedRunNotice, which builds a short display version from it); never sent to the
  // delegated CLI itself.
  instruction: string;
  model?: string; // literal configured model id (models.ts)
  // The proposal's skill. Main re-resolves it to decide browser access — the renderer never
  // sends a trusted browser flag, so a forged or unknown name just grants nothing.
  skillName?: string;
}

export interface DelegateTasksDeps {
  resolveCli: (model?: string) => CliModelSelection | undefined;
  send: (event: DelegateEvent) => void;
  newId: () => string;
  // Finder-launched Electron gets launchd's minimal PATH; detectClis already resolves the
  // login shell's real PATH for CLI detection — reuse that same string here so the actual
  // spawn can find claude/opencode/codex too (see .memory/safety-packaged-app-path-detection.md).
  resolvedPath?: string;
  // ~/.bean — for the cross-process run record (run-queue.ts) and the outbox
  // notice an interrupted run leaves for the chat window to pick up after a restart.
  dir: string;
  /** Where a "" (no project) request runs — the renderer doesn't know Bean's scratch path. */
  scratchPath?: string;
  /** Whether this skill's frontmatter says `browser: true` (re-read from disk at launch). */
  skillBrowser?: (skillName: string) => Promise<boolean>;
  run?: (req: DelegateRequest, cbs: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number) => DelegateHandle;
}

const isTerminal = (e: DelegateEvent): boolean => e.type === "done" || e.type === "failed" || e.type === "cancelled";

// Finder-launched Electron gets launchd's minimal PATH; pass the login shell's resolved PATH
// (see .memory/safety-packaged-app-path-detection.md) so a spawned claude/opencode/codex can find
// its own dependencies. Exported so main.ts's routine delegate-step adapter reuses the exact
// same spawn instead of duplicating this PATH-injection logic.
export function resolvedPathSpawnFn(resolvedPath: string | undefined): DelegateSpawnFn | undefined {
  return resolvedPath
    ? (command, args, cwd) =>
        spawn(command, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: spawnEnv({ PATH: resolvedPath, ...BEAN_GIT_IDENTITY, PWD: cwd }), // PWD: see core defaultDelegateSpawn
        })
    : undefined;
}

export { resolveDelegateSelection } from "@bean/core";

interface Task {
  cancel: DelegateHandle["cancel"];
  cancelling: boolean;
  projectPath: string;
  instruction: string;
  receipt: () => { receipt?: DelegateReceipt };
}

export function createDelegateTasks(deps: DelegateTasksDeps) {
  const run = deps.run ?? runDelegate;
  const spawnFn = resolvedPathSpawnFn(deps.resolvedPath);
  const tasks = new Map<string, Task>();

  // Release only once the delegate's own close event has actually fired (done/failed/cancelled
  // all only reach here after that — see delegate.ts's settle()/onCancelled wiring) — i.e. once
  // the child process is *confirmed* dead, not just asked to stop. interruptAll() below
  // deliberately does NOT go through this path.
  const emit = (event: DelegateEvent): void => {
    const task = tasks.get(event.taskId);
    if (event.type !== "started" && !task) return;
    // While stopping, drop output but let any terminal event settle the task: core lets a
    // timeout that fired before Stop win (onError, never onCancelled), and that failure is
    // the only terminal event this run will ever get.
    if (task?.cancelling && !isTerminal(event)) return;
    if (isTerminal(event)) {
      if (task) releaseRun(deps.dir, event.taskId);
      tasks.delete(event.taskId);
    }
    deps.send(event);
  };

  return {
    async start(asked: DelegateStartRequest): Promise<string> {
      const taskId = deps.newId();
      // "" = no project (a `/` terminal skill with none configured): run in Bean's scratch workspace.
      const req = { ...asked, projectPath: asked.projectPath || deps.scratchPath || "" };
      // Runs on one project overlap freely: each agent isolates itself in its own worktree.
      const browser = req.skillName && deps.skillBrowser ? await deps.skillBrowser(req.skillName) : false;
      const choice = deps.resolveCli(req.model);
      if (!choice) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: "No enabled delegate CLI found — enable one in Settings." }));
        return taskId;
      }
      recordRun(deps.dir, taskId, req.projectPath, process.pid);
      // Set by onDone/onError if the delegate settles synchronously during spawn (e.g. an
      // immediate failure) — before `tasks.set` below has run, so emit()'s terminal-release
      // above finds no task yet and releases nothing; handled explicitly after `run()` returns.
      let settled = false;
      // Set up before run(): its callbacks can fire synchronously.
      let receipt: { receipt?: DelegateReceipt } = {};
      const handle = run(
        {
          cli: choice.cli,
          projectPath: req.projectPath,
          prompt: req.prompt,
          ...(choice.model ? { model: choice.model } : {}),
          ...(browser ? { browser: true } : {}),
        },
        {
          onOutput: (line) => emit({ taskId, type: "output", line }),
          onDone: (result) => { settled = true; emit({ taskId, type: "done", result, ...receipt }); },
          onError: (err) => { settled = true; emit({ taskId, type: "failed", message: err.message, ...receipt }); },
          onSessionStart: (_pid, sessionId) => {
            recordDelegateSession(dbFile(deps.dir), {
              surface: "desktop", cli: choice.cli, sessionId, projectPath: req.projectPath, instruction: req.instruction,
            });
            if (isValidSessionId(sessionId)) {
              receipt = { receipt: {
                label: `${choice.cli} · ${sessionId.slice(0, 4)}…`,
                command: `cd ${shQuote(req.projectPath)} && ${resumeCommand(choice.cli, sessionId)}`,
                ...(isLiveCli(choice.cli) && isLiveSessionId(choice.cli, sessionId) ? { sessionId, agent: choice.cli } : {}),
              } };
            }
          },
        },
        spawnFn,
      );
      if (settled) {
        releaseRun(deps.dir, taskId);
        return taskId;
      }
      // The record was created against this process's own pid (nothing else to track before
      // the child existed); switch it to the child's real pid so a later interruptAll() can
      // leave it in place and boot cleanup tracks *that child*, not this (possibly
      // about-to-exit) process. See run-queue.ts's doc comment.
      if (handle.pid !== undefined) updateRunPid(deps.dir, taskId, handle.pid);
      tasks.set(taskId, {
        cancel: handle.cancel,
        cancelling: false, projectPath: req.projectPath, instruction: req.instruction,
        receipt: () => receipt,
      });
      emit({ taskId, type: "started", projectPath: req.projectPath, instruction: req.instruction });
      return taskId;
    },

    cancel(taskId: string): void {
      const t = tasks.get(taskId);
      if (!t) return;
      if (t.cancelling) return;
      t.cancelling = true;
      t.cancel(() => emit({ taskId, type: "cancelled", ...t.receipt() }));
    },

    cancelAll(): void {
      for (const [taskId, t] of [...tasks]) {
        if (t.cancelling) continue;
        t.cancelling = true;
        t.cancel(() => emit({ taskId, type: "cancelled", ...t.receipt() }));
      }
    },

    // Called only when Bean itself is quitting (before-quit) — unlike cancelAll(), doesn't wait
    // for the child to confirm termination or emit any chat event (the window is closing right
    // along with it); instead leaves a durable outbox notice so the chat window can report the
    // interruption next launch (see main.ts's startup claimOutbox("chat")).
    //
    // Deliberately does NOT release the run record: this process is about to exit, with no way
    // to know whether the delegate child (sent SIGTERM below) has actually stopped by then. The
    // record already tracks the child's own pid (see start()), so the next desktop boot sweeps it
    // once that child is verifiably gone, and a headless boot kills it.
    //
    // Also deliberately synchronous (releaseRun/enqueueOutbox are sync-internally, see their doc
    // comments): main.ts calls this directly from a plain `before-quit` listener with no
    // preventDefault/async-gating — it must be guaranteed to have written everything to disk by
    // the time it returns, not just "eventually" (Electron's before-quit doesn't reliably await
    // async work, and a preventDefault-then-requeue dance is its own source of flakiness).
    interruptAll(): void {
      for (const [, t] of [...tasks]) {
        t.cancelling = true;
        t.cancel(() => {});
        const { full, display } = interruptedRunNotice(t.projectPath, t.instruction);
        void enqueueOutbox(outboxDir(deps.dir), { transport: "chat", body: full, displayBody: display }, deps.newId);
      }
      tasks.clear();
    },
  };
}
