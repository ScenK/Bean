import { spawn } from "node:child_process";
import { runDelegate, reserveRun, releaseRun, enqueueOutbox, outboxDir } from "@bean/core";
import type { CliName, DelegateCallbacks, DelegateHandle, DelegateRequest, DelegateSpawnFn } from "@bean/core";

export type DelegateEvent =
  | { taskId: string; type: "started" }
  | { taskId: string; type: "output"; line: string }
  | { taskId: string; type: "done"; result: string }
  | { taskId: string; type: "failed"; message: string }
  | { taskId: string; type: "cancelled" };

export interface DelegateStartRequest {
  projectPath: string;
  prompt: string;
  // Short human-readable label (ProposedDelegate.instruction) — carried only for reporting an
  // interrupted run back to chat after a restart; never sent to the delegated CLI itself.
  instruction: string;
  model?: string; // canonical model id (models.ts)
}

export interface DelegateTasksDeps {
  resolveCli: () => CliName | undefined;
  send: (event: DelegateEvent) => void;
  newId: () => string;
  // Finder-launched Electron gets launchd's minimal PATH; detectClis already resolves the
  // login shell's real PATH for CLI detection — reuse that same string here so the actual
  // spawn can find claude/opencode too (see .memory/safety-packaged-app-path-detection.md).
  resolvedPath?: string;
  // ~/.bean — for the cross-process project-path reservation (run-queue.ts) and the outbox
  // notice an interrupted run leaves for the chat window to pick up after a restart.
  dir: string;
  run?: (req: DelegateRequest, cbs: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number) => DelegateHandle;
}

const isTerminal = (e: DelegateEvent): boolean => e.type === "done" || e.type === "failed" || e.type === "cancelled";
const ALREADY_RUNNING = "A run is already going in that project — wait for it or cancel it first.";

// Finder-launched Electron gets launchd's minimal PATH; pass the login shell's resolved PATH
// (see .memory/safety-packaged-app-path-detection.md) so a spawned claude/opencode can find
// its own dependencies. Exported so main.ts's routine delegate-step adapter reuses the exact
// same spawn instead of duplicating this PATH-injection logic.
export function resolvedPathSpawnFn(resolvedPath: string | undefined): DelegateSpawnFn | undefined {
  return resolvedPath
    ? (command, args, cwd) =>
        spawn(command, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: { ...process.env, PATH: resolvedPath },
        })
    : undefined;
}

interface Task {
  cancel: DelegateHandle["cancel"];
  cancelling: boolean;
  projectPath: string;
  instruction: string;
  // Same id as the reservation file (run-queue.ts) — one task, one reservation, no need for a
  // second generated id.
  reservationId: string;
}

export function createDelegateTasks(deps: DelegateTasksDeps) {
  const run = deps.run ?? runDelegate;
  const spawnFn = resolvedPathSpawnFn(deps.resolvedPath);
  const tasks = new Map<string, Task>();

  const emit = (event: DelegateEvent): void => {
    const task = tasks.get(event.taskId);
    if (event.type !== "started" && !task) return;
    if (task?.cancelling && event.type !== "cancelled") return;
    if (isTerminal(event)) {
      if (task) void releaseRun(deps.dir, task.reservationId);
      tasks.delete(event.taskId);
    }
    deps.send(event);
  };

  return {
    async start(req: DelegateStartRequest): Promise<string> {
      const taskId = deps.newId();
      // Same-project guard: this process's own instant check, same role as RunRegistry's
      // byProject map — reserveRun below extends the same invariant across processes.
      if ([...tasks.values()].some((t) => t.projectPath === req.projectPath)) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: ALREADY_RUNNING }));
        return taskId;
      }
      const cli = deps.resolveCli();
      if (!cli) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: "No delegate CLI found — install claude or opencode." }));
        return taskId;
      }
      const reservation = await reserveRun(deps.dir, req.projectPath, process.pid, () => taskId);
      if (!reservation) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: ALREADY_RUNNING }));
        return taskId;
      }
      const handle = run(
        { cli, projectPath: req.projectPath, prompt: req.prompt, model: req.model },
        {
          onOutput: (line) => emit({ taskId, type: "output", line }),
          onDone: (result) => emit({ taskId, type: "done", result }),
          onError: (err) => emit({ taskId, type: "failed", message: err.message }),
        },
        spawnFn,
      );
      tasks.set(taskId, { cancel: handle.cancel, cancelling: false, projectPath: req.projectPath, instruction: req.instruction, reservationId: reservation.id });
      emit({ taskId, type: "started" });
      return taskId;
    },

    cancel(taskId: string): void {
      const t = tasks.get(taskId);
      if (!t) return;
      if (t.cancelling) return;
      t.cancelling = true;
      t.cancel(() => emit({ taskId, type: "cancelled" }));
    },

    cancelAll(): void {
      for (const [taskId, t] of [...tasks]) {
        if (t.cancelling) continue;
        t.cancelling = true;
        t.cancel(() => emit({ taskId, type: "cancelled" }));
      }
    },

    // Called only when Bean itself is quitting (before-quit) — unlike cancelAll(), doesn't wait
    // for the child to confirm termination or emit any chat event (the window is closing right
    // along with it); instead leaves a durable outbox notice so the chat window can report the
    // interruption next launch (see main.ts's startup claimOutbox("chat")).
    async interruptAll(): Promise<void> {
      for (const [, t] of [...tasks]) {
        t.cancelling = true;
        t.cancel(() => {});
        await releaseRun(deps.dir, t.reservationId);
        await enqueueOutbox(
          outboxDir(deps.dir),
          { transport: "chat", body: `Run on ${t.projectPath} ("${t.instruction}") was interrupted when Bean closed. Ask me again to retry.` },
          deps.newId,
        );
      }
      tasks.clear();
    },
  };
}
