import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dbFile, scratchDir } from "./config.js";
import { runDelegate, type DelegateSpawnFn } from "./delegate.js";
import { isValidSessionId, recordDelegateSession } from "./delegate-runs.js";
import { runShellCommand } from "./command-step.js";
import type { CliName } from "./launcher.js";
import type { CliModelSelection } from "./models.js";
import { composePrompt } from "./prompt.js";
import type { RoutineHostDeps } from "./routine-host.js";
import {
  ROUTINE_STEP_TIMEOUT_MS,
  type CommandStepRequest, type DelegateStepRequest, type DelegateStepResult,
} from "./routine-runner.js";
import { recordRun, releaseRun, updateRunPid } from "./run-queue.js";
import { spawnEnv } from "./spawn-env.js";

export interface RoutineStepDeps {
  /** ~/.bean — scratch workspace, run records and the delegate_runs log. */
  dir: string;
  /** The step's CLI/model: a pinned `cli` must throw (never swap harness); undefined = no CLI. */
  selectCli: (req: { cli?: CliName; model?: string }) => CliModelSelection | undefined;
  /** Delegate spawn (the desktop injects its login-shell PATH); absent = core's default. */
  spawnFn?: DelegateSpawnFn;
  /** PATH for command steps (see safety-packaged-app-path-detection). */
  path: string;
}

/** The delegate/command step adapters every routine host passes to `createRoutineHost`.
 *
 * Delegate: runDelegate's callback shape → a promise, prior outputs folded into the prompt,
 * scratch workspace when the step has no project, 15-minute routine step timeout (runDelegate's
 * own default is the interactive 30). Watch-fired todo runs (req.todoId set): a project-less step
 * gets its own scratch subdir (removed afterwards) so concurrent todos don't share a workspace or
 * pile up clones. Every step's child is recorded in run-queue.ts for crash cleanup — never a lock.
 * `hold` (gated routines): the scratch subdir outlives the step; the host removes it when the run
 * ends.
 *
 * Command: same cwd rules, no run record (a check is short-lived and reads the tree). */
export function makeRoutineSteps(deps: RoutineStepDeps): Pick<RoutineHostDeps, "delegateStep" | "commandStep"> {
  const { dir } = deps;
  const delegateStep: RoutineHostDeps["delegateStep"] = (req: DelegateStepRequest, onSession, hold) =>
    new Promise<DelegateStepResult>((resolve, reject) => {
      let choice: CliModelSelection | undefined;
      try {
        choice = deps.selectCli({ cli: req.cli, model: req.model });
      } catch (err) { reject(err); return; }
      if (!choice) { reject(new Error("No enabled delegate CLI found — enable one in Settings.")); return; }
      const cli = choice.cli;
      const model = choice.model;
      const prompt =
        (req.skill ? composePrompt(req.skill, req.instruction) : req.instruction) +
        (req.memories ? `\n\n${req.memories}` : "") +
        (req.priorOutputs ? `\n\nOutput of this sprout's earlier steps:\n${req.priorOutputs}` : "");
      const perTodo = req.todoId && !req.projectPath ? join(scratchDir(dir), req.todoId) : undefined;
      const projectPath = req.projectPath ?? perTodo ?? scratchDir(dir);
      const runId = randomUUID();
      recordRun(dir, runId, projectPath, process.pid);
      if (perTodo) { mkdirSync(perTodo, { recursive: true }); hold?.scratch.add(perTodo); }
      // The shared scratch workspace must exist for the spawn's cwd.
      if (!req.projectPath && !perTodo) mkdirSync(projectPath, { recursive: true });
      const cleanup = (): void => {
        releaseRun(dir, runId);
        if (perTodo && !hold) rmSync(perTodo, { recursive: true, force: true });
      };
      const handle = runDelegate(
        {
          cli,
          projectPath,
          prompt,
          ...(model ? { model } : {}),
          ...(req.skill?.browser ? { browser: true } : {}),
          // Only the same harness can resume; a rejected id starts fresh (runDelegate's notice).
          ...(req.resume?.cli === cli ? { resume: req.resume.sessionId } : {}),
        },
        {
          onOutput: () => {},
          onDone: (out, sessionId) => {
            cleanup();
            resolve({
              output: out, cli,
              ...(model ? { model } : {}),
              ...(sessionId && isValidSessionId(sessionId) ? { sessionId } : {}),
            });
          },
          onError: (err) => { cleanup(); reject(err); },
          onSessionStart: (pid, sessionId) => {
            if (pid) updateRunPid(dir, runId, pid); // a resume fallback is a new child
            recordDelegateSession(dbFile(dir), { surface: "routine", cli, sessionId, projectPath, instruction: req.instruction });
            if (isValidSessionId(sessionId)) onSession?.(cli, sessionId, projectPath);
          },
        },
        deps.spawnFn,
        req.timeoutMinutes ? req.timeoutMinutes * 60_000 : ROUTINE_STEP_TIMEOUT_MS,
      );
      // Track the detached child, not this host: a crashed host's boot cleanup must kill the
      // delegate (run-queue.ts).
      if (handle.pid) updateRunPid(dir, runId, handle.pid);
    });

  const commandStep: RoutineHostDeps["commandStep"] = async (req: CommandStepRequest, hold) => {
    const perTodo = req.todoId && !req.projectPath ? join(scratchDir(dir), req.todoId) : undefined;
    const cwd = req.projectPath ?? perTodo ?? scratchDir(dir);
    if (!req.projectPath) mkdirSync(cwd, { recursive: true });
    if (perTodo) hold?.scratch.add(perTodo);
    try {
      return await runShellCommand(req.command, {
        cwd,
        env: spawnEnv({ PATH: deps.path, ...req.env }),
        timeoutMs: req.timeoutMinutes ? req.timeoutMinutes * 60_000 : ROUTINE_STEP_TIMEOUT_MS,
      });
    } finally {
      if (perTodo && !hold) rmSync(perTodo, { recursive: true, force: true });
    }
  };

  return { delegateStep, commandStep };
}
