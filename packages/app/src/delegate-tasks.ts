import { spawn } from "node:child_process";
import { runDelegate, reserveRun, releaseRun, updateReservationPid, enqueueOutbox, outboxDir, interruptedRunNotice } from "@bean/core";
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
  // ProposedDelegate.instruction — can be a full multi-step composed prompt, not just a short
  // label. Carried only for reporting an interrupted run back to chat after a restart (see
  // interruptedRunNotice, which builds a short display version from it); never sent to the
  // delegated CLI itself.
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
    if (task?.cancelling && event.type !== "cancelled") return;
    if (isTerminal(event)) {
      if (task) releaseRun(deps.dir, task.projectPath);
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
      const reservation = reserveRun(deps.dir, req.projectPath, process.pid, () => taskId);
      if (!reservation) {
        setImmediate(() => deps.send({ taskId, type: "failed", message: ALREADY_RUNNING }));
        return taskId;
      }
      // Set by onDone/onError if the delegate settles synchronously during spawn (e.g. an
      // immediate failure) — before `tasks.set` below has run, so emit()'s terminal-release
      // above finds no task yet and releases nothing; handled explicitly after `run()` returns.
      let settled = false;
      const handle = run(
        { cli, projectPath: req.projectPath, prompt: req.prompt, model: req.model },
        {
          onOutput: (line) => emit({ taskId, type: "output", line }),
          onDone: (result) => { settled = true; emit({ taskId, type: "done", result }); },
          onError: (err) => { settled = true; emit({ taskId, type: "failed", message: err.message }); },
        },
        spawnFn,
      );
      if (settled) {
        releaseRun(deps.dir, req.projectPath);
        return taskId;
      }
      // The reservation was created against this process's own pid (nothing else to track
      // before the child existed); switch it to the child's real pid so a later interruptAll()
      // can leave the reservation in place and have the next reserveRun() correctly track *that
      // child*, not this (possibly about-to-exit) process. See run-queue.ts's doc comment.
      if (handle.pid !== undefined) updateReservationPid(deps.dir, req.projectPath, handle.pid);
      tasks.set(taskId, { cancel: handle.cancel, cancelling: false, projectPath: req.projectPath, instruction: req.instruction });
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
    //
    // Deliberately does NOT release the reservation: this process is about to exit, with no way
    // to know whether the delegate child (sent SIGTERM below) has actually stopped by then —
    // releasing blind would let a relaunch start a second run on the same project while the old
    // child is still alive. The reservation already tracks the child's own pid (see start()), so
    // it's left in place and the *next* reserveRun() for this project correctly reports busy
    // until that child is verifiably gone (or reclaims it once it's not — same crash-recovery
    // path as an ungraceful exit).
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
