import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TURN_QUEUE_FULL, type CliName, type LiveSessionCallbacks, type LiveSessionRequest } from "@bean/core";
import {
  ASK_LIMIT, HANDOFF_CHARS, HANDOFF_ITEMS, buildHandoff, createLiveTasks, liveSpawnFn,
  type HandoffItem, type LiveEvent,
} from "../src/live-tasks.js";
import { liveBadgeAgent } from "../src/renderer/task-bubbles.js";
import type { TaskJob } from "../src/task-status.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "bean-live-tasks-"));
const record = (dir: string, id: string): { pid: number } | undefined => {
  const f = join(dir, "runs", `${id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as { pid: number } : undefined;
};

function harness(opts: { clis?: CliName[]; allowed?: (p: string) => Promise<boolean>; pid?: number; sendOk?: boolean } = {}) {
  const dir = tmp();
  const events: Array<{ owner: number; e: LiveEvent }> = [];
  const reqs: LiveSessionRequest[] = [];
  const cbs: LiveSessionCallbacks[] = [];
  const sent: string[] = [];
  let stops = 0;
  let n = 0;
  const live = createLiveTasks({
    dir,
    enabledClis: () => opts.clis ?? ["claude", "codex", "opencode"],
    projectAllowed: opts.allowed ?? (async (p) => p === "/proj" || p === "/scratch"),
    scratchPath: "/scratch",
    send: (owner, e) => { events.push({ owner, e }); },
    newId: () => `s${++n}`,
    engine: (req, c) => {
      reqs.push(req);
      cbs.push(c);
      return { pid: opts.pid, send: (t) => { sent.push(t); return opts.sendOk ?? true; }, stop: () => { stops++; } };
    },
  });
  return { live, dir, events, reqs, cbs, sent, stops: () => stops, types: () => events.map(({ e }) => e.type) };
}

describe("createLiveTasks", () => {
  it("starts, sends and stops a session, releasing its record only once the process exits", async () => {
    const h = harness();
    const res = await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "fix the bug" });
    expect(res).toEqual({ sessionId: "s1", handedOver: 0 });
    expect(h.reqs[0]).toEqual({ cli: "claude", projectPath: "/proj", prompt: "fix the bug" });
    expect(h.events[0]).toEqual({ owner: 1, e: { type: "started", sessionId: "s1", agent: "claude", seq: 1, projectPath: "/proj", handedOver: 0 } });

    h.cbs[0]!.onOutput("reading files");
    h.cbs[0]!.onTurnComplete({ result: "done", durationMs: 1200 });
    expect(h.live.send(1, "s1", "now the tests")).toBeUndefined();
    expect(h.sent).toEqual(["now the tests"]);

    h.live.stop(1, "s1");
    expect(h.stops()).toBe(1);
    expect(record(h.dir, "s1")).toBeDefined(); // the child hasn't confirmed dead yet
    h.cbs[0]!.onExit();
    expect(record(h.dir, "s1")).toBeUndefined();
    expect(h.events.map(({ e }) => [e.type, e.seq])).toEqual([["started", 1], ["output", 2], ["turn", 3], ["ended", 4]]);
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "stopped" });
    expect(h.live.send(1, "s1", "late")).toBe("That agent session has ended.");
  });

  it("reports a crash as failed and an idle/clean exit as ended", async () => {
    const h = harness();
    await h.live.start(1, { agent: "codex", projectPath: "/proj", ask: "a" });
    h.cbs[0]!.onExit(new Error("codex exited with code 1"));
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "failed", error: "codex exited with code 1" });
    await h.live.start(1, { agent: "codex", projectPath: "/proj", ask: "b" });
    h.cbs[1]!.onExit();
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "ended" });
  });

  it("refuses a second session in the same window, not in another one", async () => {
    const h = harness();
    await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "a" });
    expect(await h.live.start(1, { agent: "codex", projectPath: "/proj", ask: "b" })).toEqual({ error: expect.stringMatching(/already has an agent/) });
    expect(await h.live.start(2, { agent: "codex", projectPath: "/proj", ask: "b" })).toMatchObject({ sessionId: "s2" });
    expect(h.reqs).toHaveLength(2);
  });

  it("a switch can start the next session while the ended one is still exiting; no project = scratch", async () => {
    const h = harness();
    await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "a" });
    expect(h.live.hasSession(1)).toBe(true);
    h.live.stop(1, "s1"); // its onExit hasn't fired yet
    expect(h.live.hasSession(1)).toBe(false); // stopping counts as gone: Bean may offer again
    expect(await h.live.start(1, { agent: "codex", projectPath: "", ask: "b" })).toMatchObject({ sessionId: "s2" });
    expect(h.reqs[1]).toMatchObject({ cli: "codex", projectPath: "/scratch" });
  });

  it("a window close during startup leaves no child and no record", async () => {
    let allow!: (ok: boolean) => void;
    const h = harness({ allowed: () => new Promise((r) => { allow = r; }) });
    const pending = h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "a" });
    h.live.stopOwner(1);
    allow(true);
    expect(await pending).toEqual({ error: "Stopped before it started." });
    expect(h.reqs).toHaveLength(0);
    expect(record(h.dir, "s1")).toBeUndefined();
    expect(h.events).toHaveLength(0);
  });

  it("validates the CLI, project and payload sizes", async () => {
    const h = harness({ clis: ["claude"] });
    expect(await h.live.start(1, { agent: "codex", projectPath: "/proj", ask: "a" })).toEqual({ error: expect.stringMatching(/Codex isn't installed/) });
    expect(await h.live.start(1, { agent: "bash", projectPath: "/proj", ask: "a" })).toEqual({ error: "Invalid live session request." });
    expect(await h.live.start(1, { agent: "claude", projectPath: "/etc", ask: "a" })).toEqual({ error: "That project isn't configured in Bean." });
    expect(await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "x".repeat(ASK_LIMIT + 1) })).toEqual({ error: expect.stringMatching(/too long/) });
    expect(h.reqs).toHaveLength(0);

    const res = await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "a" });
    const id = "sessionId" in res ? res.sessionId : "";
    expect(h.live.send(1, id, "x".repeat(ASK_LIMIT + 1))).toMatch(/too long/);
    expect(h.live.send(2, id, "not my window")).toBe("That agent session has ended.");
    h.live.stop(2, id);
    expect(h.stops()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("surfaces a full next-turn queue", async () => {
    const h = harness({ sendOk: false });
    await h.live.start(1, { agent: "opencode", projectPath: "/proj", ask: "a" });
    expect(h.live.send(1, "s1", "more")).toBe(TURN_QUEUE_FULL);
  });

  it("moves claude's record to its child pid; per-turn CLIs keep this process's", async () => {
    const h = harness({ pid: 424242 });
    await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "a" });
    await h.live.start(2, { agent: "codex", projectPath: "/proj", ask: "a" });
    expect(record(h.dir, "s1")?.pid).toBe(424242);
    expect(record(h.dir, "s2")?.pid).toBe(process.pid);
  });

  it("hands the recent chat over as quoted context", async () => {
    const h = harness();
    const history: HandoffItem[] = [{ role: "user", text: "hi" }, { role: "reply", text: "hello" }];
    const res = await h.live.start(1, { agent: "claude", projectPath: "/proj", ask: "go", history });
    expect(res).toMatchObject({ handedOver: 2 });
    expect(h.reqs[0]!.prompt).toContain("> User: hi\n>\n> Bean: hello\n\ngo");
  });
});

describe("liveSpawnFn", () => {
  const probe = "const fs=require('fs');process.stdout.write(JSON.stringify({pipe:!fs.fstatSync(0).isCharacterDevice(),path:process.env.PATH,pwd:process.env.PWD}))";
  const run = async (agent: "claude" | "codex" | "opencode") => {
    const cwd = realpathSync(tmp());
    const child = liveSpawnFn(agent, "/opt/bean-test/bin:/usr/bin:/bin")(process.execPath, ["-e", probe], cwd);
    child.stdin?.end();
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    await new Promise((resolve) => child.on("close", resolve));
    return { ...JSON.parse(out) as { pipe: boolean; path: string; pwd: string }, cwd };
  };

  it("claude gets a stdin pipe; codex and opencode get stdin ignored; all get the resolved PATH and PWD", async () => {
    const claude = await run("claude");
    expect(claude.pipe).toBe(true);
    expect(claude.path).toBe("/opt/bean-test/bin:/usr/bin:/bin");
    expect(claude.pwd).toBe(claude.cwd);
    for (const agent of ["codex", "opencode"] as const) {
      const r = await run(agent);
      expect(r.pipe).toBe(false);
      expect(r.path).toBe("/opt/bean-test/bin:/usr/bin:/bin");
      expect(r.pwd).toBe(r.cwd);
    }
  });
});

describe("buildHandoff", () => {
  it("keeps the newest items in chronological order, capped by count", () => {
    const history: HandoffItem[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "reply" : "user", text: `m${i}` }));
    const r = buildHandoff(history, "ask");
    if ("error" in r) throw new Error(r.error);
    expect(r.count).toBe(HANDOFF_ITEMS);
    expect(r.prompt.indexOf("m10")).toBeGreaterThan(0);
    expect(r.prompt).not.toContain("m9\n");
    expect(r.prompt.indexOf("m10")).toBeLessThan(r.prompt.indexOf("m29"));
    expect(r.prompt.endsWith("\n\nask")).toBe(true);
  });

  it("caps the quoted context at HANDOFF_CHARS and reports the exact count", () => {
    const history: HandoffItem[] = Array.from({ length: 10 }, (_, i) => ({ role: "reply", text: `${i}`.repeat(1500), agent: "codex" }));
    const r = buildHandoff(history, "ask");
    if ("error" in r) throw new Error(r.error);
    const quoted = r.prompt.split("\n").filter((l) => l.startsWith("> Codex:"));
    expect(quoted).toHaveLength(r.count);
    expect(r.count).toBe(Math.floor(HANDOFF_CHARS / "> Codex: ".concat("x".repeat(1500)).length));
    expect(quoted.at(-1)).toContain("9999");
  });

  it("rejects an oversized ask instead of truncating it, and sends a bare ask with no history", () => {
    expect(buildHandoff([], "x".repeat(ASK_LIMIT + 1))).toEqual({ error: expect.stringMatching(/too long/) });
    expect(buildHandoff([], "  ")).toEqual({ error: "Nothing to send." });
    expect(buildHandoff([], "just this")).toEqual({ prompt: "just this", count: 0 });
  });
});

describe("liveBadgeAgent", () => {
  const job = (p: Partial<TaskJob>): TaskJob => ({ id: "j", kind: "live", name: "", line: "", detail: "", startedAt: 0, state: "running", ...p });

  it("wears the newest running desktop session's agent, and clears on end or crash", () => {
    expect(liveBadgeAgent([job({ agent: "claude", startedAt: 1 }), job({ agent: "codex", startedAt: 2 })])).toBe("codex");
    expect(liveBadgeAgent([job({ agent: "claude", state: "done" }), job({ agent: "codex", state: "failed" })])).toBeUndefined();
  });

  it("ignores chatops live sessions (reported as delegate jobs)", () => {
    expect(liveBadgeAgent([job({ kind: "delegate", name: "proj · live" })])).toBeUndefined();
  });
});

describe("main.ts live-session teardown", () => {
  // main.ts isn't unit-testable; guard the two exits that must SIGKILL live trees. The update
  // install ends in app.relaunch() + app.exit(), which skips before-quit.
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  const block = (start: string): string => main.slice(main.indexOf(start), main.indexOf("});", main.indexOf(start)));

  it("force-kills live sessions on quit and on the update relaunch", () => {
    expect(block('app.on("before-quit", () => {\n    interruptAllDelegates();')).toContain("forceKillLive();");
    expect(block("relaunch: () => {")).toContain("forceKillLive();");
  });
});
