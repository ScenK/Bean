import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { safeFetch } from "./safe-fetch.js";
import { spawnEnv } from "./spawn-env.js";
import type { WatchPollDeps } from "./watch.js";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

export async function fetchText(url: string): Promise<string> {
  const res = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
  // A consent/login wall answers 200 after a redirect — name where we ended up so the status
  // line says "→ consent.youtube.com" instead of a bare parse failure.
  const landed = new URL(res.url).host !== new URL(url).host ? ` → ${new URL(res.url).host}` : "";
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}${landed}`);
  if (landed && !/<(rss|feed)[\s>]/i.test(res.body.slice(0, 2000))) throw new Error(`feed redirected${landed}`);
  return res.body;
}

/** `/bin/sh -c` with the resolved login-shell PATH (same shape as resolvedPathSpawnFn), so a
 * Finder-launched Bean still finds `gh`/`acli`. Known limit: on timeout only the shell gets
 * SIGTERM — pipeline children may linger. */
export function execWatchCommand(resolvedPath: string): WatchPollDeps["exec"] {
  return (command) => new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], {
      timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, env: spawnEnv({ PATH: resolvedPath }),
    }, (err, stdout, stderr) => {
      if (!err) { resolve(stdout); return; }
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      const why = e.killed ? "timed out after 60s" : typeof e.code === "number" ? `exit ${e.code}` : String(e.code ?? e.message);
      const detail = (stderr || stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
      reject(new Error(detail ? `${detail} (${why})` : why));
    });
  });
}

/** Read-only CLIs worth telling the brief model about. */
const KNOWN_TOOLS = ["gh", "glab", "acli", "jira", "az", "jq", "curl", "yt-dlp", "python3", "node"];

export function detectTools(pathEnv: string): string[] {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  return KNOWN_TOOLS.filter((t) => dirs.some((d) => {
    try { accessSync(join(d, t), constants.X_OK); return true; } catch { return false; }
  }));
}

const readJson = async (file: string): Promise<unknown> => {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
};

/** Counts only: DMs go to the configured `ownerId` alone (0 = none set / owner's chat unknown). */
export async function sinkRecipients(dir: string): Promise<{ discord?: number; teams?: number }> {
  const owner = (cfg: unknown): string | undefined => {
    const id = (cfg as { ownerId?: unknown } | undefined)?.ownerId;
    return typeof id === "string" && id ? id : undefined;
  };
  const discord = await readJson(join(dir, "discord.json"));
  const teamsOwner = owner(await readJson(join(dir, "teams.json")));
  type Ref = { conversation?: { conversationType?: string }; user?: { id?: string; aadObjectId?: string } };
  const teams = (await readJson(join(dir, "teams-conversations.json"))) as Record<string, Ref> | undefined;
  return {
    ...(discord && typeof discord === "object" ? { discord: owner(discord) ? 1 : 0 } : {}),
    ...(teams && typeof teams === "object"
      ? { teams: teamsOwner ? Object.values(teams).filter((r) => r?.conversation?.conversationType === "personal" &&
        (r.user?.id === teamsOwner || r.user?.aadObjectId === teamsOwner)).length : 0 }
      : {}),
  };
}
