import { enqueueOutbox, outboxDir, type CliName, type Transport } from "@bean/core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatopsBot, ChatopsEvent } from "./chatops-servers.js";
import type { TaskJob } from "./task-status.js";

// The pieces of `bean-core` (#806) that aren't process wiring, so they test without booting it.

export const CHATOPS_BOTS: readonly ChatopsBot[] = ["discord", "teams"];

/** The bots this data directory is set up for: a bot runs exactly when its config file exists. */
export const configuredBots = (dir: string, exists: (p: string) => boolean = existsSync): ChatopsBot[] =>
  CHATOPS_BOTS.filter((bot) => exists(join(dir, `${bot}.json`)));

/** cron matches in local time, so an unset TZ silently fires in whatever the machine defaults to. */
export const tzProblem = (env: NodeJS.ProcessEnv): string | undefined =>
  env.TZ ? undefined : "bean-core: needs TZ set (e.g. TZ=America/Toronto) — cron sprouts and reminders fire in local time.";

/** Best-effort "can this CLI log in" for the boot log: its token env var or its credentials file. */
export function cliAuthPresent(cli: CliName, env: NodeJS.ProcessEnv, home: string, exists: (p: string) => boolean = existsSync): boolean {
  if (cli === "claude") {
    return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ||
      exists(join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"));
  }
  if (cli === "codex") return exists(join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
  return exists(join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "auth.json"));
}

/** What would be a desktop notification (reminders, `notify` sinks, watch alarms, missed sprouts)
 * with no shell attached: an owner DM through the outbox when a bot is configured (Discord first),
 * otherwise a log line. Checked per notice, so a bot set up later is picked up after its restart. */
export function ownerNotices(dir: string, log: (line: string) => void = console.log, exists?: (p: string) => boolean): Transport {
  return {
    name: "owner",
    available: () => true,
    send: async ({ body, title }) => {
      const bot = configuredBots(dir, exists)[0];
      if (!bot) {
        log(`bean-core: ${title ? `${title}: ` : ""}${body}`);
        return;
      }
      await enqueueOutbox(outboxDir(dir), { transport: bot, body, ...(title ? { title } : {}) }, randomUUID);
    },
  };
}

/** The status list as log lines: each finished or failed job once (running output would flood it). */
export function jobLogger(log: (line: string) => void = console.log): (jobs: TaskJob[]) => void {
  let seen = new Map<string, string>();
  return (jobs) => {
    const next = new Map<string, string>();
    for (const j of jobs) {
      if (j.state === "running") continue;
      const key = `${j.state}|${j.line}|${j.count ?? 1}`;
      next.set(j.id, key);
      if (seen.get(j.id) === key) continue;
      const detail = j.state === "failed" && j.detail && j.detail !== j.line ? ` — ${j.detail}` : "";
      log(`bean-core: ${j.name} ${j.state}: ${j.line}${detail}`);
    }
    seen = next; // only listed jobs: dismissed ones drop out instead of piling up
  };
}

/** Bot state changes as log lines, one per change (the Teams dev-tunnel endpoint included). */
export function botLogger(log: (line: string) => void = console.log): (e: ChatopsEvent) => void {
  const last: Partial<Record<ChatopsBot, string>> = {};
  return (e) => {
    const line = `bean-core: ${e.bot} ${e.running ? "running" : "stopped"}${e.error ? ` — ${e.error}` : ""}${e.endpoint ? ` (messaging endpoint ${e.endpoint})` : ""}`;
    if (last[e.bot] === line) return;
    last[e.bot] = line;
    (e.error ? console.error : log)(line);
  };
}
