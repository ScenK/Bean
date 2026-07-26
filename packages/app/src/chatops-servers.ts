import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ChatopsBot = "discord" | "teams";
export interface ChatopsState { running: boolean; error?: string; }
export type ChatopsEvent = { bot: ChatopsBot } & ChatopsState;

export interface SpawnedProcess {
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(): void;
}

const SERVER_ENTRY: Record<ChatopsBot, string> = {
  discord: "packages/discord/dist/server.js",
  teams: "packages/teams/dist/server.js",
};

/** A server that dies seconds after spawning is usually losing a race, not misconfigured —
 * most often Teams hitting EADDRINUSE against an orphan from the previous bundle that
 * `exitWhenOrphaned()` is still reaping, which is exactly what boot-time autostart runs into
 * after an update install. Retry a couple of times before leaving the row red. Deterministic
 * failures (bad token, missing config) just burn the budget in ~6s and settle on the same error.
 * ponytail: fixed delay, no backoff — three tries over six seconds doesn't need a curve. */
const MAX_START_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/** Past this, a run counts as having served rather than failed to start, so its crash gets a
 * fresh retry budget instead of being charged to the original start. */
const STABLE_MS = 10_000;

export interface ChatopsServersDeps {
  repoRoot: string;
  resolvedPath: string;
  send: (event: ChatopsEvent) => void;
  serverEntries?: Record<ChatopsBot, string>;
  extraEnv?: NodeJS.ProcessEnv;
  /** Called with the set of bots the user has switched on, whenever that intent changes.
   * Intent, not liveness: a crash or `stopAll()` at quit leaves the set alone, so main.ts can
   * restart them on the next boot. Only an explicit start/stop moves a bot in or out. */
  onEnabledChange?: (enabled: ChatopsBot[]) => void;
  spawnFn?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => SpawnedProcess;
  existsFn?: (path: string) => boolean;
  nowFn?: () => number;
  delayFn?: (cb: () => void, ms: number) => void;
}

export function createChatopsServers(deps: ChatopsServersDeps) {
  const doSpawn = deps.spawnFn ?? ((command, args, cwd, env) => spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
  const exists = deps.existsFn ?? existsSync;
  const serverEntries = deps.serverEntries ?? SERVER_ENTRY;
  const now = deps.nowFn ?? Date.now;
  const delay = deps.delayFn ?? ((cb, ms) => { setTimeout(cb, ms); });
  const procs = new Map<ChatopsBot, SpawnedProcess>();
  const state: Record<ChatopsBot, ChatopsState> = { discord: { running: false }, teams: { running: false } };
  const enabled = new Set<ChatopsBot>();
  const attempts = new Map<ChatopsBot, number>();
  // Set once by stopAll() at quit. A retry timer can outlive the kill it was scheduled by, and
  // respawning then would recreate exactly the launchd orphan stopAll() exists to prevent —
  // see .memory/safety-chatops-servers-must-die-with-the-app.md.
  let shuttingDown = false;

  const emit = (bot: ChatopsBot): void => deps.send({ bot, ...state[bot] });
  const enable = (bot: ChatopsBot): void => {
    if (enabled.has(bot)) return;
    enabled.add(bot);
    deps.onEnabledChange?.([...enabled]);
  };

  const spawnBot = (bot: ChatopsBot): void => {
    if (procs.has(bot)) return;
    const entry = join(deps.repoRoot, serverEntries[bot]);
    if (!exists(entry)) {
      state[bot] = { running: false, error: `Not built — run "pnpm --filter @bean/${bot} build" first.` };
      emit(bot);
      return;
    }
    attempts.set(bot, (attempts.get(bot) ?? 0) + 1);
    const spawnedAt = now();
    let lastErr = "";
    // Run under Electron's bundled Node (not a system "node") so the packaged app
    // needs no local Node install — ELECTRON_RUN_AS_NODE makes execPath behave as `node <entry>`.
    const child = doSpawn(process.execPath, [entry], deps.repoRoot, { ...process.env, ...deps.extraEnv, PATH: deps.resolvedPath, ELECTRON_RUN_AS_NODE: "1" });
    child.stderr?.on("data", (chunk) => { lastErr = chunk.toString().trim() || lastErr; });
    procs.set(bot, child);
    state[bot] = { running: true };
    enable(bot);
    emit(bot);
    child.on("exit", (code) => {
      procs.delete(bot);
      const crashed = code !== 0 && code !== null;
      if (now() - spawnedAt >= STABLE_MS) attempts.set(bot, 0);
      state[bot] = crashed ? { running: false, error: lastErr || `exited with code ${code}` } : { running: false };
      emit(bot);
      // enabled.has() is the "does the user still want this" check: a stop() during the delay,
      // or before the timer fires, cancels the retry.
      const retriable = crashed && !shuttingDown && enabled.has(bot) && (attempts.get(bot) ?? 0) < MAX_START_ATTEMPTS;
      if (retriable) delay(() => { if (!shuttingDown && enabled.has(bot)) spawnBot(bot); }, RETRY_DELAY_MS);
    });
  };

  return {
    status: (): Record<ChatopsBot, ChatopsState> => state,

    /** Explicit start (autostart at boot, tray, Settings) — always gets the full retry budget. */
    start(bot: ChatopsBot): void {
      attempts.set(bot, 0);
      spawnBot(bot);
    },

    stop(bot: ChatopsBot): void {
      // Deliberate stop = the user wants it off; drop it before the kill so neither the "exit"
      // handler nor a pending retry reads it as intent. Unlike stopAll(), this does not survive
      // a restart.
      if (enabled.delete(bot)) deps.onEnabledChange?.([...enabled]);
      attempts.set(bot, 0);
      procs.get(bot)?.kill();
    },

    stopAll(): void {
      shuttingDown = true;
      for (const child of procs.values()) child.kill();
    },
  };
}
