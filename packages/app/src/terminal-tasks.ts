import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { escalateKill, killPendingGroups, killTree, spawnEnv } from "@bean/core";
import type { ClientId } from "./push.js";

// Per-chat interactive terminals: a login shell in a PTY per tab, up to MAX_TABS per chat (mount),
// owned by the chat window. The tracked, interactive sibling of launcher.ts's Terminal.app
// hand-off — Bean spawns, streams, and kills it. node-pty is injected (main.ts) so this file tests without the native module.

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

/** A main→renderer push on `bean:terminal-event`, tagged with the chat (mount) and tab that own it. */
export type TerminalEvent = { mountId: string; tabId: string } & (
  | { type: "data"; data: string }
  /** The foreground command changed: its name, or none once the shell has the terminal back. */
  | { type: "busy"; command?: string }
  | { type: "exit"; code: number; signal?: number }
);

/** `shell` is the shell's display name (an idle tab's title). */
export type TerminalStartResult = { cwd: string; shell: string } | { error: string };

/** Largest single write (a paste) main accepts; the renderer chunks anything bigger. */
export const WRITE_LIMIT = 64 * 1024;
/** Flow control: unacknowledged output (chars) above HIGH pauses the PTY, below LOW resumes it. */
export const HIGH_WATERMARK = 128 * 1024;
export const LOW_WATERMARK = 16 * 1024;
export const MAX_DIMENSION = 1000;
/** Terminals (tabs) one chat may hold, pending starts included. */
export const MAX_TABS = 4;
export const STALE_PROJECT_NOTICE = "\x1b[2m[Bean] That project isn't configured anymore — opened in the scratch workspace.\x1b[0m\r\n";

const dim = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_DIMENSION;
const TAB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account's login shell (passwd, not launchd's env), /bin/zsh if unknown. */
export function accountShell(): string {
  try {
    return userInfo().shell || "/bin/zsh";
  } catch {
    return "/bin/zsh";
  }
}

/** A foreground command's display name: argv[0]'s basename, control and bidi/format characters
 * stripped (it ends up in tab titles and cards), at most 64 characters. */
export function commandName(commandLine: string): string {
  const argv0 = commandLine.trim().split(/\s+/)[0] ?? "";
  const clean = (argv0.split("/").pop() ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "");
  return [...clean].slice(0, 64).join("") || "A command";
}

// ps exits 1 when some pid is gone but still prints the rest.
const runPs = (args: string[]): Promise<string> =>
  new Promise((resolve) => execFile("ps", args, (_err, out) => resolve(String(out ?? ""))));

/** What runs in the foreground of each shell's terminal, in two `ps` calls for any number of
 * shells: shell pid → the command name of its tty's foreground process group, absent while the
 * shell has it (idle). A shell's background children (`cmd &`, a prompt's gitstatusd) don't count. */
export async function foregroundCommands(pids: readonly number[], ps: (args: string[]) => Promise<string> = runPs): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const fg = new Map<number, number>(); // shell pid → foreground pgid
  for (const line of (await ps(["-o", "pid=,tpgid=", "-p", pids.join(",")])).split("\n")) {
    const [pid, tpgid] = line.trim().split(/\s+/).map(Number);
    if (pids.includes(pid!) && Number.isInteger(tpgid) && tpgid! > 0 && tpgid !== pid) fg.set(pid!, tpgid!);
  }
  if (fg.size === 0) return new Map();
  const names = new Map<number, string>();
  for (const line of (await ps(["-o", "pid=,command=", "-p", [...new Set(fg.values())].join(",")])).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) names.set(Number(m[1]), commandName(m[2]!));
  }
  return new Map([...fg].map(([pid, pgid]) => [pid, names.get(pgid) ?? "A command"]));
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

/** A chat: the client (window) it runs in plus its mount id (push.ts). */
export interface TerminalOwner { clientId: ClientId; mountId: string }

export interface TerminalTasksDeps {
  spawn: PtyFactory;
  /** A configured project's path, or Bean's scratch workspace (main's shared check). */
  projectAllowed: (path: string) => Promise<boolean>;
  /** Where "" (no project) and a no-longer-configured project open. */
  scratchPath: string;
  /** Push a mount-tagged event, routed to the owning chat by `mountId`. */
  send: (event: TerminalEvent) => void;
  shell?: string;
  /** Batched foreground lookup (default: foregroundCommands). */
  foreground?: (pids: readonly number[]) => Promise<Map<number, string>>;
  busyPollMs?: number;
  /** SIGHUP → SIGKILL grace on stop. */
  killGraceMs?: number;
}

interface Terminal {
  mountId: string;
  tabId: string;
  /** Unset while start() awaits its checks — a stop then means "never spawn". */
  pty?: PtyProcess;
  stopping: boolean;
  cols: number;
  rows: number;
  unacked: number;
  paused: boolean;
  /** The foreground command last pushed; undefined = idle. */
  command?: string;
  exited: Promise<void>;
  settle: () => void;
}

type EventBody = TerminalEvent extends infer E ? E extends TerminalEvent ? Omit<E, "mountId" | "tabId"> : never : never;

export function createTerminalTasks(deps: TerminalTasksDeps) {
  const terms = new Map<string, Map<string, Terminal>>(); // mount id → tab id → its terminal
  const foreground = deps.foreground ?? foregroundCommands;
  let shutdown = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  const emit = (t: Terminal, body: EventBody): void => {
    deps.send({ ...body, mountId: t.mountId, tabId: t.tabId } as TerminalEvent);
  };
  const current = (t: Terminal): boolean => terms.get(t.mountId)?.get(t.tabId) === t;
  const drop = (t: Terminal): void => {
    const tabs = terms.get(t.mountId);
    if (tabs?.get(t.tabId) !== t) return;
    tabs.delete(t.tabId);
    if (tabs.size === 0) terms.delete(t.mountId);
  };
  const isLive = (t: Terminal | undefined): t is Terminal & { pty: PtyProcess } => !!t?.pty && !t.stopping;
  const live = (mountId: string, tabId: unknown): (Terminal & { pty: PtyProcess }) | undefined => {
    const t = typeof tabId === "string" ? terms.get(mountId)?.get(tabId) : undefined;
    return isLive(t) ? t : undefined;
  };
  const liveIn = (tabs: Iterable<Terminal>): Array<Terminal & { pty: PtyProcess }> => [...tabs].filter(isLive);

  /** Look up the foreground of `ts` and push `busy` wherever it changed; returns the commands. */
  const refresh = async (ts: Array<Terminal & { pty: PtyProcess }>): Promise<Array<string | undefined>> => {
    let fg = new Map<number, string>();
    try { fg = await foreground(ts.map((t) => t.pty.pid)); } catch { /* treated as idle */ }
    return ts.map((t) => {
      const command = fg.get(t.pty.pid);
      if (current(t) && command !== t.command) {
        t.command = command;
        emit(t, command === undefined ? { type: "busy" } : { type: "busy", command });
      }
      return command;
    });
  };

  // One registry-wide tick while any shell lives; a slow `ps` skips ticks rather than stacking them.
  const tick = async (): Promise<void> => {
    if (polling) return;
    const all = liveIn([...terms.values()].flatMap((tabs) => [...tabs.values()]));
    if (all.length === 0) { clearInterval(poll); poll = undefined; return; }
    polling = true;
    try { await refresh(all); } finally { polling = false; }
  };
  const ensurePoll = (): void => {
    if (poll) return;
    poll = setInterval(() => { void tick(); }, deps.busyPollMs ?? 1000);
    poll.unref?.();
  };

  const stop = (mountId: string, tabId: unknown): Promise<void> => {
    const t = typeof tabId === "string" ? terms.get(mountId)?.get(tabId) : undefined;
    if (!t) return Promise.resolve();
    if (!t.pty) {
      // Still validating: start() sees it gone and spawns nothing.
      drop(t);
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
    async start(owner: TerminalOwner, tabId: unknown, rawPath: unknown, cols: unknown, rows: unknown): Promise<TerminalStartResult> {
      if (typeof tabId !== "string" || !TAB_ID.test(tabId) || typeof rawPath !== "string" || !dim(cols) || !dim(rows)) {
        return { error: "Invalid terminal request." };
      }
      if (shutdown) return { error: "Bean is quitting." };
      const { mountId } = owner;
      const tabs = terms.get(mountId) ?? new Map<string, Terminal>();
      if (tabs.has(tabId)) return { error: "This tab already has a terminal." };
      if (tabs.size >= MAX_TABS) return { error: `A chat holds at most ${MAX_TABS} terminals.` };
      // Reserved before any await (the cap check above is in the same synchronous section), so a
      // double start, a fifth tab, release, or quit during validation finds it.
      let settle = (): void => {};
      const exited = new Promise<void>((r) => { settle = r; });
      const t: Terminal = { mountId, tabId, stopping: false, cols, rows, unacked: 0, paused: false, exited, settle };
      tabs.set(tabId, t);
      terms.set(mountId, tabs);
      let cwd = rawPath || deps.scratchPath;
      let stale = false;
      if (cwd !== deps.scratchPath) {
        let allowed = false;
        try { allowed = await deps.projectAllowed(cwd); } catch { /* treated as not allowed */ }
        if (!allowed) { cwd = deps.scratchPath; stale = true; }
      }
      if (shutdown || !current(t)) {
        drop(t);
        t.settle();
        return { error: "Stopped before it started." };
      }
      const shell = deps.shell ?? accountShell();
      try {
        t.pty = deps.spawn(shell, ["-l"], {
          name: "xterm-256color", cols, rows, cwd,
          env: spawnEnv({
            TERM: "xterm-256color", COLORTERM: "truecolor", PWD: cwd,
            // Finder-launched apps get no LANG; a shell without one mangles UTF-8.
            ...(process.env.LANG ? {} : { LANG: "en_US.UTF-8" }),
          }),
        });
      } catch (err) {
        drop(t);
        t.settle();
        return { error: `The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}` };
      }
      const pty = t.pty;
      pty.onData((data) => {
        if (!current(t)) return;
        t.unacked += data.length;
        if (!t.paused && t.unacked > HIGH_WATERMARK) { t.paused = true; pty.pause(); }
        emit(t, { type: "data", data });
      });
      pty.onExit(({ exitCode, signal }) => {
        drop(t);
        emit(t, { type: "exit", code: exitCode, ...(signal ? { signal } : {}) });
        t.settle();
      });
      ensurePoll();
      if (stale) emit(t, { type: "data", data: STALE_PROJECT_NOTICE });
      return { cwd, shell: commandName(shell) };
    },

    /** Keystrokes/paste. False = refused (no such tab, wrong shape, or past WRITE_LIMIT). */
    write(mountId: string, tabId: unknown, data: unknown): boolean {
      const t = live(mountId, tabId);
      if (!t || typeof data !== "string" || data.length > WRITE_LIMIT) return false;
      t.pty.write(data);
      return true;
    },

    resize(mountId: string, tabId: unknown, cols: unknown, rows: unknown): void {
      const t = live(mountId, tabId);
      if (!t || !dim(cols) || !dim(rows) || (cols === t.cols && rows === t.rows)) return;
      t.cols = cols;
      t.rows = rows;
      t.pty.resize(cols, rows);
    },

    /** The renderer consumed `chars` of this tab's output (xterm's write callback). */
    ack(mountId: string, tabId: unknown, chars: unknown): void {
      const t = live(mountId, tabId);
      if (!t || typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
      t.unacked = Math.max(0, t.unacked - chars);
      if (t.paused && t.unacked < LOW_WATERMARK) { t.paused = false; t.pty.resume(); }
    },

    /** Hang up one tab's shell and its jobs; resolves once it's gone (the entry is held until then). */
    stop,

    /** Every tab of a chat — its release, or a stop that names no tab. */
    async stopMount(mountId: string): Promise<void> {
      await Promise.all([...(terms.get(mountId)?.keys() ?? [])].map((tabId) => stop(mountId, tabId)));
    },

    /** Fresh check for a close prompt: the commands running in this chat's shells right now (one
     * tab's when `tabId` is given), idle shells left out. */
    async runningCommand(mountId: string, tabId?: unknown): Promise<string[]> {
      const tabs = terms.get(mountId);
      if (!tabs) return [];
      const ts = tabId === undefined ? liveIn(tabs.values()) : [live(mountId, tabId)].filter(isLive);
      if (ts.length === 0) return [];
      return (await refresh(ts)).filter((c): c is string => c !== undefined);
    },

    /** before-quit / update relaunch: SIGKILL every tree now — stop()'s escalation would never fire
     * on an exiting process — and refuse any start still validating. */
    killAll(): void {
      shutdown = true;
      clearInterval(poll);
      poll = undefined;
      for (const tabs of terms.values()) {
        for (const t of [...tabs.values()]) {
          if (t.pty) killTree(t.pty.pid, "SIGKILL");
          else { drop(t); t.settle(); }
        }
      }
      killPendingGroups();
    },
  };
}

export type TerminalTasks = ReturnType<typeof createTerminalTasks>;
