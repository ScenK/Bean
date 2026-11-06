import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

/** What a routine command step reports: the exit code and a capped stdout+stderr tail. */
export interface CommandStepOutcome { exitCode: number; output: string }

export interface ShellCommandOptions {
  cwd: string;
  /** Full child env (the caller supplies PATH — see safety-packaged-app-path-detection). */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Aborted = SIGKILL the group and reject (once the pipes close) — the sprout's Stop. */
  signal?: AbortSignal;
  /** Test seam; defaults to node's spawn. */
  spawnFn?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
}

export const COMMAND_OUTPUT_CAP = 16_000;

// Process groups of running command steps. Detached, so they'd outlive Bean (and its timeout)
// on quit — killAllCommands() is the quit-time backstop, like killAllDelegates().
const liveGroups = new Set<number>();

const killGroup = (pid: number): void => {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
};

/** SIGKILL every running command step's process group, synchronously. For app quit only. */
export function killAllCommands(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
}

export const STOPPED_BY_YOU = "Stopped by you";

/** Runs `command` via `/bin/sh -c` in its own process group. Resolves with the exit code (a
 * signal-killed shell counts as 128 + signal number) and the combined output tail; rejects on
 * spawn failure, timeout or abort — both SIGKILL the whole group, so pipeline/background
 * children die with the shell, and reject only once the pipes close. A killed command never
 * resolves as an exit code, so a gate can't read it as FAIL. */
export function runShellCommand(command: string, opts: ShellCommandOptions): Promise<CommandStepOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error(STOPPED_BY_YOU)); return; }
    const child = (opts.spawnFn ?? spawn)("/bin/sh", ["-c", command], {
      cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid) liveGroups.add(pid);
    let tail = "";
    const take = (chunk: Buffer | string): void => {
      tail = (tail + chunk.toString()).slice(-COMMAND_OUTPUT_CAP);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let timedOut = false;
    let aborted = false;
    const kill = (): void => { if (pid) killGroup(pid); else child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = (): void => { aborted = true; kill(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pid) liveGroups.delete(pid);
    };
    child.on("error", (err) => { done(); reject(err); });
    child.on("close", (code, signal) => {
      done();
      if (aborted) { reject(new Error(STOPPED_BY_YOU)); return; }
      if (timedOut) {
        reject(new Error(`command timed out after ${Math.max(1, Math.round(opts.timeoutMs / 60_000))} minutes`));
        return;
      }
      const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);
      resolve({ exitCode, output: tail });
    });
  });
}
