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
  run?: (req: DelegateRequest, cbs: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number) => DelegateHandle;
}

const isTerminal = (e: DelegateEvent): boolean => e.type === "done" || e.type === "failed" || e.type === "cancelled";

export function createDelegateTasks(deps: DelegateTasksDeps) {
  const run = deps.run ?? runDelegate;
  const tasks = new Map<string, { cancel: () => void }>();

  const emit = (event: DelegateEvent): void => {
    if (event.type !== "started" && !tasks.has(event.taskId)) return;
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
      );
      tasks.set(taskId, { cancel: handle.cancel });
      emit({ taskId, type: "started" });
      return taskId;
    },

    cancel(taskId: string): void {
      const t = tasks.get(taskId);
      if (!t) return;
      t.cancel();
      emit({ taskId, type: "cancelled" });
    },

    cancelAll(): void {
      for (const [taskId, t] of [...tasks]) {
        t.cancel();
        emit({ taskId, type: "cancelled" });
      }
    },
  };
}
