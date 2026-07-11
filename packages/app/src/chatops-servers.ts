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

export interface ChatopsServersDeps {
  repoRoot: string;
  resolvedPath: string;
  send: (event: ChatopsEvent) => void;
  serverEntries?: Record<ChatopsBot, string>;
  extraEnv?: NodeJS.ProcessEnv;
  spawnFn?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => SpawnedProcess;
  existsFn?: (path: string) => boolean;
}

export function createChatopsServers(deps: ChatopsServersDeps) {
  const doSpawn = deps.spawnFn ?? ((command, args, cwd, env) => spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
  const exists = deps.existsFn ?? existsSync;
  const serverEntries = deps.serverEntries ?? SERVER_ENTRY;
  const procs = new Map<ChatopsBot, SpawnedProcess>();
  const state: Record<ChatopsBot, ChatopsState> = { discord: { running: false }, teams: { running: false } };

  const emit = (bot: ChatopsBot): void => deps.send({ bot, ...state[bot] });

  return {
    status: (): Record<ChatopsBot, ChatopsState> => state,

    start(bot: ChatopsBot): void {
      if (procs.has(bot)) return;
      const entry = join(deps.repoRoot, serverEntries[bot]);
      if (!exists(entry)) {
        state[bot] = { running: false, error: `Not built — run "pnpm --filter @bean/${bot} build" first.` };
        emit(bot);
        return;
      }
      let lastErr = "";
      const child = doSpawn("node", [entry], deps.repoRoot, { ...process.env, ...deps.extraEnv, PATH: deps.resolvedPath });
      child.stderr?.on("data", (chunk) => { lastErr = chunk.toString().trim() || lastErr; });
      procs.set(bot, child);
      state[bot] = { running: true };
      emit(bot);
      child.on("exit", (code) => {
        procs.delete(bot);
        state[bot] = code === 0 || code === null ? { running: false } : { running: false, error: lastErr || `exited with code ${code}` };
        emit(bot);
      });
    },

    stop(bot: ChatopsBot): void {
      procs.get(bot)?.kill();
    },

    stopAll(): void {
      for (const child of procs.values()) child.kill();
    },
  };
}
