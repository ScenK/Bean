import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { escalateKill, killPendingGroups, killTree, spawnEnv } from "@bean/core";

// Per-chat interactive terminals: one login shell in a PTY per chat (mount), owned by the chat
// window. The tracked, interactive sibling of launcher.ts's Terminal.app hand-off — Bean spawns,
// streams, and kills it. node-pty is injected (main.ts) so this file tests without the native module.

/** The node-pty `IPty` surface Bean uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}
export interface PtySpawnOptions { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyProcess;

/** A main→renderer push on `bean:terminal-event`, tagged with the chat (mount) that owns it. */
export type TerminalEvent = { mountId: string } & (
  | { type: "data"; data: string }
  /** The shell has (or no longer has) a child process — something is running. */
  | { type: "busy"; busy: boolean }
  | { type: "exit"; code: number; signal?: number }
);

export type TerminalStartResult = { cwd: string } | { error: string };

/** Largest single write (a paste) main accepts; the renderer chunks anything bigger. */
export const WRITE_LIMIT = 64 * 1024;
/** Flow control: unacknowledged output (chars) above HIGH pauses the PTY, below LOW resumes it. */
export const HIGH_WATERMARK = 128 * 1024;
export const LOW_WATERMARK = 16 * 1024;
export const MAX_DIMENSION = 1000;
export const STALE_PROJECT_NOTICE = "\x1b[2m[Bean] That project isn't configured anymore — opened in the scratch workspace.\x1b[0m\r\n";

const dim = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_DIMENSION;

/** The account's login shell (passwd, not launchd's env), /bin/zsh if unknown. */
export function accountShell(): string {
  try {
    return userInfo().shell || "/bin/zsh";
  } catch {
    return "/bin/zsh";
  }
}

/** Whether `pid` has a child process (pgrep exits 0 on a match, 1 on none). */
export function hasChildProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile("pgrep", ["-P", String(pid)], (err) => resolve(!err)));
}

/** A link the terminal asked to open: http(s) only, normalized; anything else is refused. */
export function terminalLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 8192) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface TerminalOwner { senderId: number; mountId: string }

export interface TerminalTasksDeps {
  spawn: PtyFactory;
  /** A configured project's path, or Bean's scratch workspace (main's shared check). */
  projectAllowed: (path: string) => Promise<boolean>;
  /** Where "" (no project) and a no-longer-configured project open. */
  scratchPath: string;
  send: (senderId: number, event: TerminalEvent) => void;
  shell?: string;
  hasChild?: (pid: number) => Promise<boolean>;
  busyPollMs?: number;
  /** SIGHUP → SIGKILL grace on stop. */
  killGraceMs?: number;
}

interface Terminal {
  senderId: number;
  /** Unset while start() awaits its checks — a stop then means "never spawn". */
  pty?: PtyProcess;
  stopping: boolean;
  cols: number;
  rows: number;
  unacked: number;
  paused: boolean;
  busy: boolean;
  poll?: ReturnType<typeof setInterval>;
  exited: Promise<void>;
  settle: () => void;
}

export function createTerminalTasks(deps: TerminalTasksDeps) {
  const terms = new Map<string, Terminal>(); // mount id → its terminal
  const hasChild = deps.hasChild ?? hasChildProcess;
  let shutdown = false;

  const emit = (mountId: string, t: Terminal, body: TerminalEvent extends infer E ? E extends TerminalEvent ? Omit<E, "mountId"> : never : never): void => {
    deps.send(t.senderId, { ...body, mountId } as TerminalEvent);
  };

  const live = (mountId: string): Terminal | undefined => {
    const t = terms.get(mountId);
    return t?.pty && !t.stopping ? t : undefined;
  };

  const checkBusy = async (mountId: string, t: Terminal): Promise<boolean> => {
    let busy = false;
    try { busy = await hasChild(t.pty!.pid); } catch { /* treated as idle */ }
    if (terms.get(mountId) === t && busy !== t.busy) {
      t.busy = busy;
      emit(mountId, t, { type: "busy", busy });
    }
    return busy;
  };

  const stop = (mountId: string): Promise<void> => {
    const t = terms.get(mountId);
    if (!t) return Promise.resolve();
    if (!t.pty) {
      // Still validating: start() sees it gone and spawns nothing.
      terms.delete(mountId);
      t.settle();
      return t.exited;
    }
    if (!t.stopping) {
      t.stopping = true;
      // Interactive shells ignore SIGTERM; HUP is the hang-up a closed terminal sends. The tree
      // snapshot catches backgrounded jobs in their own groups (kill-tree.ts); SIGKILL follows.
      escalateKill(killTree(t.pty.pid, "SIGHUP"), deps.killGraceMs);
    }
    return t.exited; // the entry stays until the shell is gone
  };

  return {
    async start(owner: TerminalOwner, rawPath: unknown, cols: unknown, rows: unknown): Promise<TerminalStartResult> {
      if (typeof rawPath !== "string" || !dim(cols) || !dim(rows)) return { error: "Invalid terminal request." };
      if (shutdown) return { error: "Bean is quitting." };
      const { mountId } = owner;
      if (terms.has(mountId)) return { error: "This chat already has a terminal." };
      // Reserved before any await, so a double start, release, or quit during validation finds it.
      let settle = (): void => {};
      const exited = new Promise<void>((r) => { settle = r; });
      const t: Terminal = { senderId: owner.senderId, stopping: false, cols, rows, unacked: 0, paused: false, busy: false, exited, settle };
      terms.set(mountId, t);
      let cwd = rawPath || deps.scratchPath;
      let stale = false;
      if (cwd !== deps.scratchPath) {
        let allowed = false;
        try { allowed = await deps.projectAllowed(cwd); } catch { /* treated as not allowed */ }
        if (!allowed) { cwd = deps.scratchPath; stale = true; }
      }
      if (shutdown || terms.get(mountId) !== t) {
        if (terms.get(mountId) === t) terms.delete(mountId);
        return { error: "Stopped before it started." };
      }
      try {
        t.pty = deps.spawn(deps.shell ?? accountShell(), ["-l"], {
          name: "xterm-256color", cols, rows, cwd,
          env: spawnEnv({
            TERM: "xterm-256color", COLORTERM: "truecolor", PWD: cwd,
            // Finder-launched apps get no LANG; a shell without one mangles UTF-8.
            ...(process.env.LANG ? {} : { LANG: "en_US.UTF-8" }),
          }),
        });
      } catch (err) {
        terms.delete(mountId);
        t.settle();
        return { error: `The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}` };
      }
      const pty = t.pty;
      pty.onData((data) => {
        if (terms.get(mountId) !== t) return;
        t.unacked += data.length;
        if (!t.paused && t.unacked > HIGH_WATERMARK) { t.paused = true; pty.pause(); }
        emit(mountId, t, { type: "data", data });
      });
      pty.onExit(({ exitCode, signal }) => {
        if (t.poll) clearInterval(t.poll);
        if (terms.get(mountId) === t) terms.delete(mountId);
        emit(mountId, t, { type: "exit", code: exitCode, ...(signal ? { signal } : {}) });
        t.settle();
      });
      t.poll = setInterval(() => { void checkBusy(mountId, t); }, deps.busyPollMs ?? 1000);
      t.poll.unref?.();
      if (stale) emit(mountId, t, { type: "data", data: STALE_PROJECT_NOTICE });
      return { cwd };
    },

    /** Keystrokes/paste. False = refused (no terminal, wrong shape, or past WRITE_LIMIT). */
    write(mountId: string, data: unknown): boolean {
      const t = live(mountId);
      if (!t || typeof data !== "string" || data.length > WRITE_LIMIT) return false;
      t.pty!.write(data);
      return true;
    },

    resize(mountId: string, cols: unknown, rows: unknown): void {
      const t = live(mountId);
      if (!t || !dim(cols) || !dim(rows) || (cols === t.cols && rows === t.rows)) return;
      t.cols = cols;
      t.rows = rows;
      t.pty!.resize(cols, rows);
    },

    /** The renderer consumed `chars` of output (xterm's write callback). */
    ack(mountId: string, chars: unknown): void {
      const t = live(mountId);
      if (!t || typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
      t.unacked = Math.max(0, t.unacked - chars);
      if (t.paused && t.unacked < LOW_WATERMARK) { t.paused = false; t.pty!.resume(); }
    },

    /** Hang up the shell and its jobs; resolves once it's gone (the entry is held until then). */
    stop,

    /** Fresh check for a close prompt: is something running in this chat's shell right now? */
    async isBusy(mountId: string): Promise<boolean> {
      const t = live(mountId);
      return t ? checkBusy(mountId, t) : false;
    },

    /** before-quit / update relaunch: SIGKILL every tree now — stop()'s escalation would never fire
     * on an exiting process — and refuse any start still validating. */
    killAll(): void {
      shutdown = true;
      for (const [mountId, t] of terms) {
        if (t.poll) clearInterval(t.poll);
        if (t.pty) killTree(t.pty.pid, "SIGKILL");
        else terms.delete(mountId);
      }
      killPendingGroups();
    },
  };
}

export type TerminalTasks = ReturnType<typeof createTerminalTasks>;
