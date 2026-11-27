import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dbFile, recordAuditEnd, recordAuditStart } from "@bean/core";
import { auditCommand, botLogger, cliAuthPresent, configuredBots, escapeTerminal, formatAuditRow, jobLogger, ownerNotices, parseAuditArgs, tzProblem } from "../src/headless.js";
import type { TaskJob } from "../src/task-status.js";

describe("bean-core helpers", () => {
  it("refuses an unset TZ with one line", () => {
    expect(tzProblem({ TZ: "UTC" })).toBeUndefined();
    expect(tzProblem({})).toMatch(/TZ/);
    expect(tzProblem({})).not.toContain("\n");
  });

  it("runs a bot exactly when its config file exists", () => {
    expect(configuredBots("/d", () => false)).toEqual([]);
    expect(configuredBots("/d", (p) => p === "/d/teams.json")).toEqual(["teams"]);
    expect(configuredBots("/d", () => true)).toEqual(["discord", "teams"]);
  });

  it("detects CLI auth from env or the credentials file", () => {
    const none = (): boolean => false;
    expect(cliAuthPresent("claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, "/h", none)).toBe(true);
    expect(cliAuthPresent("claude", {}, "/h", none)).toBe(false);
    expect(cliAuthPresent("claude", {}, "/h", (p) => p === "/h/.claude/.credentials.json")).toBe(true);
    expect(cliAuthPresent("codex", { CODEX_HOME: "/c" }, "/h", (p) => p === "/c/auth.json")).toBe(true);
    expect(cliAuthPresent("opencode", {}, "/h", (p) => p === "/h/.local/share/opencode/auth.json")).toBe(true);
    expect(cliAuthPresent("agy", {}, "/h", () => true)).toBeUndefined(); // keychain: unknown, not missing
  });

  it("sends notices to the first configured bot's owner DM, else logs them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-core-"));
    try {
      const log = vi.fn();
      await ownerNotices(dir, log, () => false).send({ title: "⏰ Reminder", body: "water" });
      expect(log).toHaveBeenCalledWith("bean-core: ⏰ Reminder: water");

      await ownerNotices(dir, log, (p) => p === join(dir, "teams.json")).send({ body: "hi", meta: { open: "x" } });
      const outbox = join(dir, "outbox");
      const [file] = readdirSync(outbox);
      const msg = JSON.parse(readFileSync(join(outbox, file!), "utf8")) as Record<string, unknown>;
      expect(msg).toMatchObject({ transport: "teams", body: "hi" });
      expect(msg).not.toHaveProperty("channel"); // no channel = the owner's DM
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs each finished or failed job once, never running output", () => {
    const log = vi.fn();
    const onJobs = jobLogger(log);
    const job = (over: Partial<TaskJob>): TaskJob => ({ id: "r", kind: "routine", name: "Sprout", line: "", detail: "", startedAt: 0, state: "running", ...over });
    onJobs([job({ line: "step 1" })]);
    onJobs([job({ state: "failed", line: "boom", detail: "stack" })]);
    onJobs([job({ state: "failed", line: "boom", detail: "stack" })]);
    expect(log.mock.calls).toEqual([["bean-core: Sprout failed: boom — stack"]]);
    onJobs([]); // dismissed
    onJobs([job({ state: "failed", line: "boom", detail: "stack" })]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("logs bot changes once each, with the Teams endpoint", () => {
    const log = vi.fn();
    const onEvent = botLogger(log);
    onEvent({ bot: "teams", running: true, enabled: true });
    onEvent({ bot: "teams", running: true, enabled: true });
    onEvent({ bot: "teams", running: true, enabled: true, endpoint: "https://x.devtunnels.ms/api/messages" });
    expect(log.mock.calls).toEqual([
      ["bean-core: teams running"],
      ["bean-core: teams running (messaging endpoint https://x.devtunnels.ms/api/messages)"],
    ]);
  });
});

describe("bean-core audit", () => {
  const now = new Date("2026-11-26T12:00:00.000Z");

  it("parses the flags and refuses bad ones", () => {
    expect(parseAuditArgs([], now)).toEqual({});
    expect(parseAuditArgs(["--since", "2h", "--limit", "5", "--project", "web", "--actor", "u1"], now)).toEqual({
      since: "2026-11-26T10:00:00.000Z", limit: 5, project: "web", actor: "u1",
    });
    expect(parseAuditArgs(["--since", "7d"], now)).toEqual({ since: "2026-11-19T12:00:00.000Z" });
    for (const bad of [["--since", "2 hours"], ["--limit", "0"], ["--limit", "-3"], ["--limit"], ["--project", "--actor", "x"], ["--bogus", "1"], ["stray"]]) {
      expect(parseAuditArgs(bad, now)).toHaveProperty("error");
    }
  });

  it("escapes newlines, control characters, ANSI and bidi overrides", () => {
    expect(escapeTerminal("a\nb\r\tc")).toBe("a\\nb\\r\\tc");
    expect(escapeTerminal("\x1b[31mred\x1b]0;title\x07")).toBe("\\x1b[31mred\\x1b]0;title\\x07");
    expect(escapeTerminal("x\u009by\u202ez\u2028")).toBe("x\\x9by\\u202ez\\u2028");
    expect(escapeTerminal("plain 中文 /p/bean")).toBe("plain 中文 /p/bean");
  });

  it("prints filtered rows escaped, and exits 0 with no rows or no bean.db (without creating one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-audit-cli-"));
    const lines: string[] = [];
    expect(auditCommand(dir, [], (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(["No chatops runs recorded."]);
    expect(existsSync(dbFile(dir))).toBe(false);

    const f = dbFile(dir);
    const base = { surface: "discord" as const, conversationId: "c1", trigger: "card" as const, projectPath: "/p/bean", cli: "claude" };
    recordAuditStart(f, { ...base, runId: "r1", channelName: "ops\x1b[2J", instruction: "fix\nit\x1b[31m", askedBy: { id: "u1", name: "al\nice" }, confirmedBy: { id: "u2", name: "bob" } }, new Date("2026-11-26T10:00:00Z"));
    recordAuditEnd(f, "r1", "done", undefined, new Date("2026-11-26T10:01:05Z"));
    recordAuditStart(f, { ...base, runId: "r2", projectPath: "/p/web", instruction: "deploy" }, new Date("2026-11-26T11:00:00Z"));

    lines.length = 0;
    expect(auditCommand(dir, ["--project", "bean"], (l) => lines.push(l))).toBe(0);
    expect(lines).toHaveLength(1);
    const out = lines[0]!;
    expect(out).not.toMatch(/\x1b/);
    expect(out.split("\n")).toEqual([
      "2026-11-26T10:00:00.000Z  done (1m 5s)  card  discord #ops\\x1b[2J  run r1",
      "  asked by al\\nice (u1), confirmed by bob (u2)",
      "  /p/bean  claude",
      "  instruction: fix\\nit\\x1b[31m",
    ]);

    lines.length = 0;
    auditCommand(dir, ["--limit", "1"], (l) => lines.push(l));
    expect(lines.map((l) => l.split("\n")[0])).toEqual(["2026-11-26T11:00:00.000Z  running  card  discord c1  run r2"]);
    expect(auditCommand(dir, ["--actor", "nobody"], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("No chatops runs recorded.");
    expect(auditCommand(dir, ["--limit", "x"], () => {})).toBe(2);
  });

  it("formats a continuation's grant, a cancel, the edited card text and the session", () => {
    const out = formatAuditRow({
      run_id: "r", started_at: "t", ended_at: "t2", duration_ms: 3_725_000, surface: "teams", conversation_id: "c", channel_name: null,
      trigger: "continuation", asked_by_id: null, asked_by_name: null, confirmed_by_id: null, confirmed_by_name: null, authority_id: "u7",
      cancelled_by_id: "u3", cancelled_by_name: null, project_path: "/p", skill: "ship", cli: "codex", model: "gpt", instruction: "go",
      instruction_proposed: "go now", session_id: "s1", outcome: "cancelled",
    });
    expect(out.split("\n")).toEqual([
      "t  cancelled (1h 2m)  continuation  teams c  run r",
      "  granted by u7, cancelled by u3",
      "  /p  codex/gpt  skill ship  session s1",
      "  instruction: go",
      "  proposed:    go now",
    ]);
  });
});
