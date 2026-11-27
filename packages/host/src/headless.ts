import { dbFile, enqueueOutbox, outboxDir, queryRunAudit, type AuditQuery, type AuditRow, type CliName, type Transport } from "@bean/core";
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

/** Best-effort "can this CLI log in" for the boot log: its token env var or its credentials file.
 * undefined = can't tell from files (agy keeps its login in the OS keychain, on every platform). */
export function cliAuthPresent(cli: CliName, env: NodeJS.ProcessEnv, home: string, exists: (p: string) => boolean = existsSync): boolean | undefined {
  if (cli === "claude") {
    return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ||
      exists(join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"));
  }
  if (cli === "codex") return exists(join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
  if (cli === "agy") return undefined;
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

const AUDIT_USAGE = "usage: bean-core audit [--since <n>m|h|d|w] [--limit <n>] [--project <substr>] [--actor <id>]";
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `bean-core audit` flags → a query, or a usage error. */
export function parseAuditArgs(args: string[], now: Date = new Date()): AuditQuery | { error: string } {
  const q: AuditQuery = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--since", "--limit", "--project", "--actor"].includes(flag ?? "")) return { error: `unknown option ${flag ?? ""}. ${AUDIT_USAGE}` };
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value. ${AUDIT_USAGE}` };
    if (flag === "--since") {
      const m = /^(\d+)([mhdw])$/.exec(value);
      if (!m) return { error: `--since takes a duration like 30m, 24h, 7d or 2w. ${AUDIT_USAGE}` };
      q.since = new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2]!]!).toISOString();
    } else if (flag === "--limit") {
      if (!/^[1-9]\d*$/.test(value)) return { error: `--limit takes a positive whole number. ${AUDIT_USAGE}` };
      q.limit = Number(value);
    } else if (flag === "--project") q.project = value;
    else q.actor = value;
  }
  return q;
}

/** Untrusted text (instructions, display and channel names) made terminal-safe: control
 * characters, newlines, ESC (so no ANSI sequence survives), line separators and bidi overrides
 * become visible escapes. */
export function escapeTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

const person = (id: string | null, name: string | null): string =>
  name && id ? `${escapeTerminal(name)} (${escapeTerminal(id)})` : escapeTerminal(name ?? id ?? "");

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** One `run_audit` row as a few indented lines; every field escaped. */
export function formatAuditRow(r: AuditRow): string {
  const e = escapeTerminal;
  const where = `${e(r.surface)} ${r.channel_name ? `#${e(r.channel_name)}` : e(r.conversation_id)}`;
  const who = [
    r.asked_by_id || r.asked_by_name ? `asked by ${person(r.asked_by_id, r.asked_by_name)}` : "",
    r.confirmed_by_id || r.confirmed_by_name ? `confirmed by ${person(r.confirmed_by_id, r.confirmed_by_name)}` : "",
    r.authority_id ? `granted by ${e(r.authority_id)}` : "",
    r.cancelled_by_id || r.cancelled_by_name ? `cancelled by ${person(r.cancelled_by_id, r.cancelled_by_name)}` : "",
  ].filter(Boolean).join(", ");
  const lines = [
    `${e(r.started_at)}  ${e(r.outcome)}${r.duration_ms !== null ? ` (${duration(r.duration_ms)})` : ""}  ${e(r.trigger)}  ${where}  run ${e(r.run_id)}`,
    ...(who ? [`  ${who}`] : []),
    `  ${e(r.project_path)}  ${e(r.cli)}${r.model ? `/${e(r.model)}` : ""}${r.skill ? `  skill ${e(r.skill)}` : ""}${r.session_id ? `  session ${e(r.session_id)}` : ""}`,
    `  instruction: ${e(r.instruction)}`,
    ...(r.instruction_proposed !== null ? [`  proposed:    ${e(r.instruction_proposed)}`] : []),
  ];
  return lines.join("\n");
}

/** `bean-core audit`: read-only; never creates `bean.db`. 0 = printed (or nothing to print), 2 = usage. */
export function auditCommand(dir: string, args: string[], log: (line: string) => void = console.log, exists: (p: string) => boolean = existsSync): number {
  const q = parseAuditArgs(args);
  if ("error" in q) {
    console.error(`bean-core audit: ${q.error}`);
    return 2;
  }
  const rows = exists(dbFile(dir)) ? queryRunAudit(dbFile(dir), q) : [];
  if (rows.length === 0) log("No chatops runs recorded.");
  for (const r of rows) log(formatAuditRow(r));
  return 0;
}
