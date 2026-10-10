import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { CliName } from "./launcher.js";

export interface DelegateRequest {
  cli: CliName;
  projectPath: string;
  prompt: string;
  model?: string; // literal --model value (clis.json); flag omitted when unset
  /** This CLI's own session id to continue (thread sessions); runDelegate falls back to a
   * fresh run if the CLI rejects it. */
  resume?: string;
  /** From the resolved skill's `browser: true` frontmatter only — never from instruction text
   * or a renderer/model-supplied flag. claude gets `--chrome` (else `--no-chrome`); codex
   * already has browser tools; opencode is refused before spawn. */
  browser?: boolean;
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

// A headless run that can't do its job still exits 0, so the model must say so in-band:
// runDelegate turns a final answer whose first line starts with `FAILED:` into onError.
export const FAILED_SENTINEL_INSTRUCTION =
  "\n\nIf you could not fully complete the task — including when browser tools are missing or the " +
  "browser isn't reachable, or when you would need to ask the user anything (permission, login, " +
  "which browser) — your final message's first line must be `FAILED: <one-line reason>`. " +
  "A headless run ends when you answer; there are no background retries.";

export const OPENCODE_BROWSER_REFUSAL = "This skill needs the browser; opencode can't — pick a claude or codex model.";

/** The reason after a first-line `FAILED:` (CRLF-safe), or undefined when the run succeeded. */
export function failedReason(result: string): string | undefined {
  const first = (result.trimStart().split(/\r?\n/, 1)[0] ?? "").trim();
  if (!first.startsWith("FAILED:")) return undefined;
  return first.slice("FAILED:".length).trim() || "the delegate reported it could not complete the task";
}

/** `codex exec [resume <id>]` argv, shared by delegate runs and codex live sessions (one spawn
 * per turn). `prompt` is passed as-is — callers append their own trailer/sentinel. */
export function codexExecArgs(req: { prompt: string; model?: string; resume?: string }): string[] {
  return [
    // `codex exec resume <id> <prompt>` accepts these flags too (not --sandbox; codex-cli 0.160).
    "exec",
    ...(req.resume ? ["resume"] : []),
    "--json",
    // Full bypass, matching the claude branch below: headless runs can't answer
    // approval prompts, and the workspace-write sandbox blocks network (git push).
    "--dangerously-bypass-approvals-and-sandbox",
    // codex exec refuses non-git dirs; Bean's scratch workspace isn't a repo.
    "--skip-git-repo-check",
    ...(req.model ? ["--model", req.model] : []),
    // `--` terminates option parsing so a prompt starting with "-"/"--" (a markdown
    // bullet, "---" frontmatter, "--help") is read as text, not parsed as a codex flag.
    "--",
    ...(req.resume ? [req.resume] : []),
    req.prompt,
  ];
}

// Headless one-shot delegation, unlike launcher.ts's interactive TUI launches.
export function delegateCommand(req: DelegateRequest): { command: string; args: string[] } {
  const modelArgs = req.model ? ["--model", req.model] : [];
  const prompt = req.prompt + GIT_TRAILER_INSTRUCTION + FAILED_SENTINEL_INSTRUCTION;
  const resume = req.resume;
  if (req.cli === "claude") {
    return {
      command: "claude",
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        // True bypass, same as live-session.ts: headless runs can't answer permission prompts,
        // and `--permission-mode auto`'s classifier doesn't run headless (verified 2026-07,
        // v2.1.214 — every would-ask action is denied), so an allowlist stalls night routines.
        "--dangerously-skip-permissions",
        // Explicit both ways: headless claude only loads Claude in Chrome with --chrome (2.1.287),
        // and --no-chrome guards against a future default turning it on for every delegate.
        req.browser ? "--chrome" : "--no-chrome",
        ...(resume ? ["--resume", resume] : []),
        ...modelArgs,
      ],
    };
  }
  if (req.cli === "codex") return { command: "codex", args: codexExecArgs({ prompt, model: req.model, resume }) };
  // --format json: the only opencode output that carries the session id (sessionID on every event).
  // `--` as in the codex branch: opencode's yargs otherwise parses a "-"-leading prompt as flags
  // and prints help instead of running (verified opencode 1.18.32).
  return {
    command: "opencode",
    args: ["run", "--auto", "--format", "json", ...(resume ? ["--session", resume] : []), ...modelArgs, "--", prompt],
  };
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

export function codexTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown; text?: unknown; command?: unknown } } | null;
  if (e?.type !== "item.completed" || !e.item) return undefined;
  const item = e.item;
  if (item.type === "agent_message") return typeof item.text === "string" && item.text.trim() ? item.text.trim() : undefined;
  if (item.type === "reasoning") return undefined;
  if (item.type === "command_execution" && typeof item.command === "string") return `▸ ${item.command}`;
  return typeof item.type === "string" ? `▸ ${item.type}` : undefined;
}

// Unlike claude's separate `result` event, codex's final answer is just the last
// agent_message — runDelegate keeps overwriting `result` so the last one wins.
export function codexResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; item?: { type?: unknown; text?: unknown } } | null;
  if (e?.type !== "item.completed" || e.item?.type !== "agent_message") return undefined;
  return typeof e.item.text === "string" ? e.item.text : undefined;
}

export function opencodeTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; part?: { text?: unknown; tool?: unknown } } | null;
  if (e?.type === "text") return typeof e.part?.text === "string" && e.part.text.trim() ? e.part.text.trim() : undefined;
  if (e?.type === "tool_use" && typeof e.part?.tool === "string") return `▸ ${e.part.tool}`;
  return undefined;
}

// Same shape as codex: the final answer is the last text part, so the last one wins.
export function opencodeResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; part?: { text?: unknown } } | null;
  return e?.type === "text" && typeof e.part?.text === "string" ? e.part.text : undefined;
}

/** The CLI's own session id, taken only from the event that proves the session actually
 * started (a rejected claude --resume still echoes the id on its error `result`). */
export function sessionIdOf(cli: CliName, event: unknown): string | undefined {
  const e = event as { type?: unknown; subtype?: unknown; session_id?: unknown; thread_id?: unknown; sessionID?: unknown } | null;
  const id =
    cli === "claude" ? (e?.type === "system" && e.subtype === "init" ? e.session_id : undefined)
    : cli === "codex" ? (e?.type === "thread.started" ? e.thread_id : undefined)
    : e?.sessionID;
  return typeof id === "string" && id ? id : undefined;
}

export interface DelegateCallbacks {
  onOutput: (line: string) => void;
  /** sessionId: the CLI's own session id when it reported one — pass it back as `resume`. */
  onDone: (result: string, sessionId?: string) => void;
  onError: (err: Error) => void;
  /** The CLI reported its session started, from the child with this pid. After this point a
   * rejected-resume retry can no longer happen, so the child's pid is safe to track. Fires at
   * most once per run, so callers can keep `sessionId` for every terminal outcome (done, error,
   * cancelled, timeout) — not just onDone. */
  onSessionStart?: (pid: number | undefined, sessionId: string) => void;
}

export interface DelegateHandle {
  cancel: (onCancelled?: () => void) => void;
  // The first spawned child's pid, once known (undefined only if spawnFn's process object never got
  // one — practically always defined). Lets a caller track *this specific process*, not just
  // "whoever was calling runDelegate", for cross-restart liveness checks (see run-queue.ts's
  // updateReservationPid / .memory/project-durable-run-queue.md).
  pid: number | undefined;
}

export type DelegateSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;

const defaultDelegateSpawn: DelegateSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY } });

export const DELEGATE_TIMEOUT_MS = 30 * 60_000;

// Every unsettled delegate's immediate group-kill. Children are spawned `detached` (own process
// group), so they don't die with the host — and cancel()'s SIGTERM→5s→SIGKILL escalation never
// reaches its SIGKILL when the host exits right after. killAllDelegates() is the quit-time backstop.
const liveKills = new Set<() => void>();

/** SIGKILL every running delegate's process group, synchronously. For app quit only: no
 * callbacks fire (the host is exiting). Covers every caller of runDelegate — chat tasks,
 * routine steps, the routine builder. */
export function killAllDelegates(): void {
  for (const k of [...liveKills]) k();
  liveKills.clear();
}

export function runDelegate(
  req: DelegateRequest,
  callbacks: DelegateCallbacks,
  spawnFn: DelegateSpawnFn = defaultDelegateSpawn,
  timeoutMs: number = DELEGATE_TIMEOUT_MS,
): DelegateHandle {
  // Refused before anything is spawned or scheduled: no timer, no liveKills entry. Settles
  // synchronously, same as a spawn failure — every caller already handles that.
  if (req.browser && req.cli === "opencode") {
    callbacks.onError(new Error(OPENCODE_BROWSER_REFUSAL));
    return { pid: undefined, cancel: () => {} };
  }
  let resume = req.resume;
  let command = "";
  let child!: ChildProcess;

  let settled = false;
  let cancelling = false;
  let timedOut = false;
  let onCancelled: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let result: string | undefined;
  let sessionId: string | undefined;
  let rawLines: string[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";
  let notice = "";

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    liveKills.delete(killNow);
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

  // Guarded: a synchronous spawnFn throw leaves no child, and one throwing entry would abort the sweep.
  const killNow = (): void => { if (child) kill("SIGKILL"); };
  liveKills.add(killNow);

  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
  }, timeoutMs);

  const handleLine = (line: string): void => {
    if (!line.trim() || settled || cancelling) return;
    rawLines.push(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      callbacks.onOutput(line);
      return;
    }
    if (!sessionId) {
      sessionId = sessionIdOf(req.cli, event);
      if (sessionId) callbacks.onSessionStart?.(child.pid, sessionId);
    }
    if (req.cli === "claude") {
      const r = claudeResult(event);
      if (r !== undefined) {
        result = r;
        return;
      }
      const tail = claudeTailLine(event);
      if (tail) callbacks.onOutput(tail);
      return;
    }
    // codex/opencode: a message is both the running tail AND the (latest) result.
    const r = req.cli === "codex" ? codexResult(event) : opencodeResult(event);
    if (r !== undefined) {
      result = r;
    }
    const tail = req.cli === "codex" ? codexTailLine(event) : opencodeTailLine(event);
    if (tail) callbacks.onOutput(tail);
  };

  const spawnAttempt = (): void => {
    const cmd = delegateCommand({ ...req, resume });
    command = cmd.command;
    result = undefined;
    sessionId = undefined;
    rawLines = [];
    stdoutBuf = "";
    stderrBuf = "";
    const c = spawnFn(cmd.command, cmd.args, req.projectPath);
    child = c;

    c.stdout?.on("data", (chunk: Buffer) => {
      if (child !== c) return;
      stdoutBuf += chunk.toString("utf8");
      for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
        handleLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    });

    c.stderr?.on("data", (chunk: Buffer) => {
      if (child !== c) return;
      stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
    });

    c.on("error", (err: Error) => {
      if (child === c) settle(() => callbacks.onError(err));
    });
    c.on("close", (code: number | null) => {
      if (settled || child !== c) return;
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
        const out = result ?? rawLines.join("\n");
        // Checked before the resume notice is prepended; never retried (a post may have gone out).
        const failed = failedReason(out);
        if (failed !== undefined) settle(() => callbacks.onError(new Error(failed)));
        else settle(() => callbacks.onDone(notice + out, sessionId));
        return;
      }
      // Died before the session started: the CLI rejected the resume id (store cleared, other
      // cwd, …). Never fail the run for that — start fresh once and say so in the result.
      if (resume && !sessionId) {
        notice = `(Couldn't resume the earlier ${req.cli} session, so this run started fresh.)\n\n`;
        resume = undefined;
        spawnAttempt();
        callbacks.onOutput(notice.trim());
        return;
      }
      const tail = stderrBuf.trim().split("\n").slice(-5).join("\n");
      settle(() => callbacks.onError(new Error(`${command} exited with code ${code}${tail ? ` - ${tail}` : ""}`)));
    });
  };

  spawnAttempt();

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
