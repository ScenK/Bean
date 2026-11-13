import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { botLogger, cliAuthPresent, configuredBots, jobLogger, ownerNotices, tzProblem } from "../src/headless.js";
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
