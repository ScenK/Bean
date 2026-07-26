import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ChatopsBot = "discord" | "teams";
/** `running` is the process; `enabled` is the user's switch — the two come apart while a crashed
 * bot waits on a retry, and after it has given up entirely. The Start/Stop toggle must follow
 * `enabled`, not `running`: a bot that's enabled but dead still needs an off switch, or its
 * intent is stuck on and it autostarts every boot with no way to say no. */
export interface ChatopsState { running: boolean; enabled: boolean; error?: string; }
export type ChatopsEvent = { bot: ChatopsBot } & ChatopsState;

export interface SpawnedProcess {
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  /** Node gives `code === null` when the child died from a signal, with the name in `signal` —
   * both are needed to tell "we killed it" from "the OS killed it". */
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

const SERVER_ENTRY: Record<ChatopsBot, string> = {
  discord: "packages/discord/dist/server.js",
  teams: "packages/teams/dist/server.js",
};

/** A server that dies seconds after spawning is usually losing a race, not misconfigured —
 * most often Teams hitting EADDRINUSE against an orphan from the previous bundle that
 * `exitWhenOrphaned()` is still reaping. Retry a couple of times before leaving the row red;
 * deterministic failures (bad token, missing config) just burn the budget and settle on the
 * same error.
 *
 * The delay is deliberately longer than `exitWhenOrphaned()`'s 5s poll period
 * (core/src/chatops/orphan-guard.ts): the orphan can hold the port for up to one full tick after
 * its parent dies, so a budget that expires inside that window would give up while the only
 * thing wrong is a port that's about to free itself. Two retries 5s apart clear it with margin.
 * ponytail: fixed delay, no backoff — three tries doesn't need a curve. */
const MAX_START_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
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
  // Liveness only — `enabled` is the separate source of truth for intent, folded in by view().
  const liveness: Record<ChatopsBot, { running: boolean; error?: string }> = { discord: { running: false }, teams: { running: false } };
  const enabled = new Set<ChatopsBot>();
  const attempts = new Map<ChatopsBot, number>();
  // Set once by stopAll() at quit. A retry timer can outlive the kill it was scheduled by, and
  // respawning then would recreate exactly the launchd orphan stopAll() exists to prevent —
  // see .memory/safety-chatops-servers-must-die-with-the-app.md.
  let shuttingDown = false;

  const view = (bot: ChatopsBot): ChatopsState => ({ ...liveness[bot], enabled: enabled.has(bot) });
  const emit = (bot: ChatopsBot): void => deps.send({ bot, ...view(bot) });
  const enable = (bot: ChatopsBot): void => {
    if (enabled.has(bot)) return;
    enabled.add(bot);
    deps.onEnabledChange?.([...enabled]);
  };

  const spawnBot = (bot: ChatopsBot): void => {
    if (procs.has(bot)) return;
    const entry = join(deps.repoRoot, serverEntries[bot]);
    if (!exists(entry)) {
      liveness[bot] = { running: false, error: `Not built — run "pnpm --filter @bean/${bot} build" first.` };
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
    liveness[bot] = { running: true };
    enable(bot);
    emit(bot);
    child.on("exit", (code, signal) => {
      procs.delete(bot);
      // These are daemons: they run until told otherwise, so *any* exit we didn't ask for is
      // abnormal and the code carries no useful signal about intent. We are the only ones who
      // take a bot out of `enabled` or set `shuttingDown`, so those two flags alone identify the
      // exits we asked for. Both servers catch SIGTERM and exit(0) — so an external `kill` looks
      // identical to a clean shutdown, and a code-shaped test would let it leave the bot enabled,
      // silent and offline. Same trap as `code === null` for signal deaths.
      const deliberate = shuttingDown || !enabled.has(bot);
      const crashed = !deliberate;
      if (now() - spawnedAt >= STABLE_MS) attempts.set(bot, 0);
      liveness[bot] = crashed
        ? { running: false, error: lastErr || (signal ? `killed by ${signal}` : `exited unexpectedly (code ${code})`) }
        : { running: false };
      emit(bot);
      // `crashed` already excludes the deliberate exits; this is just the budget check. The
      // timer callback re-tests both flags, since a stop() can land during the delay.
      const retriable = crashed && (attempts.get(bot) ?? 0) < MAX_START_ATTEMPTS;
      if (retriable) delay(() => { if (!shuttingDown && enabled.has(bot)) spawnBot(bot); }, RETRY_DELAY_MS);
    });
  };

  return {
    status: (): Record<ChatopsBot, ChatopsState> => ({ discord: view("discord"), teams: view("teams") }),

    /** Explicit start (autostart at boot, tray, Settings) — always gets the full retry budget.
     * Also clears `shuttingDown`: it's only set on the way out, so if the process is still here
     * asking for a bot, that exit didn't happen and retries shouldn't stay dead for the session. */
    start(bot: ChatopsBot): void {
      shuttingDown = false;
      attempts.set(bot, 0);
      spawnBot(bot);
    },

    stop(bot: ChatopsBot): void {
      // Deliberate stop = the user wants it off; drop it before the kill so neither the "exit"
      // handler nor a pending retry reads it as intent. Unlike stopAll(), this does not survive
      // a restart.
      if (enabled.delete(bot)) deps.onEnabledChange?.([...enabled]);
      attempts.set(bot, 0);
      const child = procs.get(bot);
      // No process to kill means no "exit" event, so this is the only chance to tell the UI the
      // switch moved — that's the path that turns off a bot which crashed or gave up retrying.
      if (child) child.kill(); else emit(bot);
    },

    stopAll(): void {
      shuttingDown = true;
      for (const child of procs.values()) child.kill();
    },
  };
}
