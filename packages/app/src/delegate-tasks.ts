import { spawn } from "node:child_process";
import { runDelegate } from "@bean/core";
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
}

export interface DelegateTasksDeps {
  resolveCli: () => CliName | undefined;
  send: (event: DelegateEvent) => void;
  newId: () => string;
  // Finder-launched Electron gets launchd's minimal PATH; detectClis already resolves the
  // login shell's real PATH for CLI detection — reuse that same string here so the actual
  // spawn can find claude/opencode too (see .memory/safety-packaged-app-path-detection.md).
  resolvedPath?: string;
  run?: (req: DelegateRequest, cbs: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number) => DelegateHandle;
}

const isTerminal = (e: DelegateEvent): boolean => e.type === "done" || e.type === "failed" || e.type === "cancelled";

export function createDelegateTasks(deps: DelegateTasksDeps) {
  const run = deps.run ?? runDelegate;
  const spawnFn: DelegateSpawnFn | undefined = deps.resolvedPath
    ? (command, args, cwd) =>
        spawn(command, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env: { ...process.env, PATH: deps.resolvedPath },
        })
    : undefined;
  const tasks = new Map<string, { cancel: DelegateHandle["cancel"]; cancelling: boolean }>();

  const emit = (event: DelegateEvent): void => {
    const task = tasks.get(event.taskId);
    if (event.type !== "started" && !task) return;
    if (task?.cancelling && event.type !== "cancelled") return;
    if (isTerminal(event)) tasks.delete(event.taskId);
    deps.send(event);
  };

  return {
    start(req: DelegateStartRequest): string {
      const taskId = deps.newId();
      const cli = deps.resolveCli();
      if (!cli) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: "No delegate CLI found — install claude or opencode." }));
        return taskId;
      }
      const handle = run(
        { cli, projectPath: req.projectPath, prompt: req.prompt },
        {
          onOutput: (line) => emit({ taskId, type: "output", line }),
          onDone: (result) => emit({ taskId, type: "done", result }),
          onError: (err) => emit({ taskId, type: "failed", message: err.message }),
        },
        spawnFn,
      );
      tasks.set(taskId, { cancel: handle.cancel, cancelling: false });
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
  };
}
