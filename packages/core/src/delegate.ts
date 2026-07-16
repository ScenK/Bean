import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { CliName } from "./launcher.js";
import { resolveModelAlias } from "./models.js";

export interface DelegateRequest {
  cli: CliName;
  projectPath: string;
  prompt: string;
  model?: string; // canonical model id (models.ts); flag omitted if the model has no alias on this CLI
}

// Bean commits under its own identity, not the local user's — see .memory (git identity for delegate commits).
export const BEAN_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Bean",
  GIT_AUTHOR_EMAIL: "bean@localhost",
  GIT_COMMITTER_NAME: "Bean",
  GIT_COMMITTER_EMAIL: "bean@localhost",
};

// GIT_AUTHOR/COMMITTER env vars (see BEAN_GIT_IDENTITY) set the commit's identity fields, but
// GitHub only renders a contributor badge for a name that also appears in the message body —
// same reason Claude Code's own commits carry a Co-Authored-By trailer. The delegated CLI writes
// the commit message itself, so the only way to get the trailer in is to ask for it in the prompt.
export const GIT_TRAILER_INSTRUCTION =
  "\n\nIf this task involves a git commit, append this trailer to the commit message: " +
  `Co-Authored-By: ${BEAN_GIT_IDENTITY.GIT_AUTHOR_NAME} <${BEAN_GIT_IDENTITY.GIT_AUTHOR_EMAIL}>`;

// Headless one-shot delegation, unlike launcher.ts's interactive TUI launches.
export function delegateCommand(req: DelegateRequest): { command: string; args: string[] } {
  const alias = req.model ? resolveModelAlias(req.model, req.cli) : undefined;
  const prompt = req.prompt + GIT_TRAILER_INSTRUCTION;
  if (req.cli === "claude") {
    return {
      command: "claude",
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
        ...(alias ? ["--model", alias] : []),
      ],
    };
  }
  return { command: "opencode", args: ["run", "--auto", ...(alias ? ["--model", alias] : []), prompt] };
}

export function claudeTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; message?: { content?: unknown } } | null;
  if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) return undefined;

  const parts: string[] = [];
  for (const block of e.message.content as { type?: unknown; text?: unknown; name?: unknown }[]) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
    else if (block?.type === "tool_use" && typeof block.name === "string") parts.push(`▸ ${block.name}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function claudeResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; result?: unknown } | null;
  return e?.type === "result" && typeof e.result === "string" ? e.result : undefined;
}

export interface DelegateCallbacks {
  onOutput: (line: string) => void;
  onDone: (result: string) => void;
  onError: (err: Error) => void;
}

export interface DelegateHandle {
  cancel: (onCancelled?: () => void) => void;
  // The spawned child's pid, once known (undefined only if spawnFn's process object never got
  // one — practically always defined). Lets a caller track *this specific process*, not just
  // "whoever was calling runDelegate", for cross-restart liveness checks (see run-queue.ts's
  // updateReservationPid / .memory/project-durable-run-queue.md).
  pid: number | undefined;
}

export type DelegateSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;

const defaultDelegateSpawn: DelegateSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY } });

export const DELEGATE_TIMEOUT_MS = 30 * 60_000;

export function runDelegate(
  req: DelegateRequest,
  callbacks: DelegateCallbacks,
  spawnFn: DelegateSpawnFn = defaultDelegateSpawn,
  timeoutMs: number = DELEGATE_TIMEOUT_MS,
): DelegateHandle {
  const { command, args } = delegateCommand(req);
  const child = spawnFn(command, args, req.projectPath);

  let settled = false;
  let cancelling = false;
  let timedOut = false;
  let onCancelled: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let result: string | undefined;
  const rawLines: string[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    fn();
  };

  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
  }, timeoutMs);

  const handleLine = (line: string): void => {
    if (!line.trim() || settled || cancelling) return;
    rawLines.push(line);
    if (req.cli !== "claude") {
      callbacks.onOutput(line);
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      callbacks.onOutput(line);
      return;
    }
    const r = claudeResult(event);
    if (r !== undefined) {
      result = r;
      return;
    }
    const tail = claudeTailLine(event);
    if (tail) callbacks.onOutput(tail);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
      handleLine(stdoutBuf.slice(0, i));
      stdoutBuf = stdoutBuf.slice(i + 1);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
  });

  child.on("error", (err: Error) => settle(() => callbacks.onError(err)));
  child.on("close", (code: number | null) => {
    if (settled) return;
    if (timedOut) {
      settle(() => callbacks.onError(new Error(`delegate timed out after ${Math.round(timeoutMs / 60_000)} minutes`)));
      return;
    }
    if (cancelling) {
      settle(() => onCancelled?.());
      return;
    }
    if (stdoutBuf.trim()) handleLine(stdoutBuf);
    if (code === 0) {
      settle(() => callbacks.onDone(result ?? rawLines.join("\n")));
      return;
    }
    const tail = stderrBuf.trim().split("\n").slice(-5).join("\n");
    settle(() => callbacks.onError(new Error(`${command} exited with code ${code}${tail ? ` - ${tail}` : ""}`)));
  });

  return {
    pid: child.pid,
    cancel: (done) => {
      if (settled || cancelling) return;
      cancelling = true;
      onCancelled = done;
      clearTimeout(timer);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
    },
  };
}
