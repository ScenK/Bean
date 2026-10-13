import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

/** What a routine command step reports: the exit code and a capped stdout+stderr tail. */
export interface CommandStepOutcome { exitCode: number; output: string }

export interface ShellCommandOptions {
  cwd: string;
  /** Full child env (the caller supplies PATH — see safety-packaged-app-path-detection). */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Test seam; defaults to node's spawn. */
  spawnFn?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
}

export const COMMAND_OUTPUT_CAP = 16_000;

/** Runs `command` via `/bin/sh -c` in its own process group. Resolves with the exit code (a
 * signal-killed shell counts as 128 + signal number) and the combined output tail; rejects on
 * spawn failure or timeout — the timeout SIGKILLs the whole group, so pipeline/background
 * children die with the shell, and rejects only once the pipes close. */
export function runShellCommand(command: string, opts: ShellCommandOptions): Promise<CommandStepOutcome> {
  return new Promise((resolve, reject) => {
    const child = (opts.spawnFn ?? spawn)("/bin/sh", ["-c", command], {
      cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const take = (chunk: Buffer | string): void => {
      tail = (tail + chunk.toString()).slice(-COMMAND_OUTPUT_CAP);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, opts.timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`command timed out after ${Math.max(1, Math.round(opts.timeoutMs / 60_000))} minutes`));
        return;
      }
      const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);
      resolve({ exitCode, output: tail });
    });
  });
}
