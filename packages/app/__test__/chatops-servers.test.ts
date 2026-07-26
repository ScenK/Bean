import { describe, expect, it } from "vitest";
import { createChatopsServers, type ChatopsBot, type ChatopsEvent, type SpawnedProcess } from "../src/chatops-servers.js";

function fakeProcess() {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const proc: SpawnedProcess = {
    stderr: { on: (event, cb) => { (listeners[event] ??= []).push(cb as (arg: unknown) => void); } },
    on: (event, cb) => { (listeners[event] ??= []).push(cb as (arg: unknown) => void); },
    kill: () => { emit("exit", null); },
  };
  const emit = (event: string, arg: unknown) => { for (const cb of listeners[event] ?? []) cb(arg); };
  return { proc, emit };
}

function harness({ built = true }: { built?: boolean } = {}) {
  const sent: ChatopsEvent[] = [];
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  const procs: ReturnType<typeof fakeProcess>[] = [];
  const enabled: ChatopsBot[][] = [];
  const retries: (() => void)[] = [];
  let clock = 0;
  const servers = createChatopsServers({
    repoRoot: "/repo",
    resolvedPath: "/usr/bin",
    send: (e) => sent.push(e),
    onEnabledChange: (bots) => enabled.push(bots),
    existsFn: () => built,
    nowFn: () => clock,
    delayFn: (cb) => { retries.push(cb); },
    spawnFn: (command, args, cwd) => {
      spawned.push({ command, args, cwd });
      const p = fakeProcess();
      procs.push(p);
      return p.proc;
    },
  });
  /** Fires every retry the code has scheduled so far (the real delayFn is a setTimeout). */
  const flushRetries = (): void => { for (const cb of retries.splice(0)) cb(); };
  const advance = (ms: number): void => { clock += ms; };
  return { servers, sent, spawned, procs, enabled, retries, flushRetries, advance };
}

/** Crash the newest spawned process with a non-zero exit, then let its retry fire. */
function crashAndRetry(h: ReturnType<typeof harness>): void {
  h.procs.at(-1)!.emit("exit", 1);
  h.flushRetries();
}

describe("createChatopsServers", () => {
  it("start spawns the built server entry under Electron's own node and emits running", () => {
    const h = harness();
    h.servers.start("discord");
    expect(h.spawned).toEqual([{ command: process.execPath, args: ["/repo/packages/discord/dist/server.js"], cwd: "/repo" }]);
    expect(h.sent).toEqual([{ bot: "discord", running: true, enabled: true }]);
  });

  it("can start a packaged server bundle from resources", () => {
    const sent: ChatopsEvent[] = [];
    const spawned: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const servers = createChatopsServers({
      repoRoot: "/Resources",
      resolvedPath: "/usr/bin",
      send: (e) => sent.push(e),
      existsFn: (p) => p === "/Resources/chatops/discord/server.js",
      spawnFn: (command, args, cwd, env) => {
        spawned.push({ command, args, cwd, env });
        return fakeProcess().proc;
      },
      serverEntries: { discord: "chatops/discord/server.js", teams: "chatops/teams/server.js" },
      extraEnv: { BEAN_BUILTIN_DIR: "/Resources/builtin" },
    });

    servers.start("discord");

    expect(spawned).toEqual([{ command: process.execPath, args: ["/Resources/chatops/discord/server.js"], cwd: "/Resources", env: expect.objectContaining({ PATH: "/usr/bin", BEAN_BUILTIN_DIR: "/Resources/builtin", ELECTRON_RUN_AS_NODE: "1" }) }]);
    expect(sent).toEqual([{ bot: "discord", running: true, enabled: true }]);
  });

  it("start is a no-op while already running", () => {
    const h = harness();
    h.servers.start("discord");
    h.servers.start("discord");
    expect(h.spawned).toHaveLength(1);
  });

  it("reports a helpful error when the package isn't built", () => {
    const sent: ChatopsEvent[] = [];
    const servers = createChatopsServers({
      repoRoot: "/repo", resolvedPath: "/usr/bin", send: (e) => sent.push(e), existsFn: () => false,
    });
    servers.start("teams");
    expect(sent).toEqual([{ bot: "teams", running: false, enabled: false, error: 'Not built — run "pnpm --filter @bean/teams build" first.' }]);
  });

  it("exit with a non-zero code surfaces the last stderr line as the error", () => {
    const h = harness();
    h.servers.start("discord");
    h.procs[0]!.emit("data", Buffer.from("boom: missing config\n"));
    h.procs[0]!.emit("exit", 1);
    expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false, enabled: true, error: "boom: missing config" });
  });

  it("clean exit (code 0) clears running with no error", () => {
    const h = harness();
    h.servers.start("teams");
    h.procs[0]!.emit("exit", 0);
    expect(h.sent.at(-1)).toEqual({ bot: "teams", running: false, enabled: true });
  });

  it("stop kills the tracked process; stopping an untracked bot is a no-op", () => {
    const h = harness();
    h.servers.start("discord");
    h.servers.stop("discord");
    expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false, enabled: false });
    expect(() => h.servers.stop("teams")).not.toThrow();
  });

  it("status reflects the current state of both bots", () => {
    const h = harness();
    h.servers.start("discord");
    expect(h.servers.status()).toEqual({ discord: { running: true, enabled: true }, teams: { running: false, enabled: false } });
  });

  it("stopAll kills every running process", () => {
    const h = harness();
    h.servers.start("discord");
    h.servers.start("teams");
    h.servers.stopAll();
    // Still enabled — quitting is not the user switching them off.
    expect(h.servers.status()).toEqual({ discord: { running: false, enabled: true }, teams: { running: false, enabled: true } });
  });

  // The enabled set is user intent, not liveness — it's what main.ts replays on the next boot.
  describe("onEnabledChange (autostart intent)", () => {
    it("start adds the bot and stop removes it", () => {
      const h = harness();
      h.servers.start("discord");
      h.servers.start("teams");
      h.servers.stop("discord");
      expect(h.enabled).toEqual([["discord"], ["discord", "teams"], ["teams"]]);
    });

    it("a crash keeps the bot enabled so the next boot restarts it", () => {
      const h = harness();
      h.servers.start("teams");
      h.procs[0]!.emit("exit", 1);
      expect(h.enabled.at(-1)).toEqual(["teams"]);
    });

    it("stopAll at quit leaves the enabled set intact", () => {
      const h = harness();
      h.servers.start("discord");
      h.servers.start("teams");
      h.servers.stopAll();
      expect(h.enabled.at(-1)).toEqual(["discord", "teams"]);
    });

    it("a start that fails because the package isn't built enables nothing", () => {
      const h = harness({ built: false });
      h.servers.start("discord");
      expect(h.enabled).toEqual([]);
    });

    // Without this the intent is a one-way door: the UI drives Stop off `enabled`, so if stopping
    // a dead-but-enabled bot didn't clear and emit, it would autostart every boot forever.
    it("stop clears the intent and emits even when nothing is running", () => {
      const h = harness();
      h.servers.start("discord");
      crashAndRetry(h);
      crashAndRetry(h);
      crashAndRetry(h); // gave up: enabled, but no process
      expect(h.servers.status().discord).toEqual({ running: false, enabled: true, error: "exited with code 1" });

      h.servers.stop("discord");
      expect(h.enabled.at(-1)).toEqual([]);
      expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false, enabled: false, error: "exited with code 1" });
    });

    it("persists once per bot, not on every retry respawn", () => {
      const h = harness();
      h.servers.start("teams");
      crashAndRetry(h);
      expect(h.enabled).toEqual([["teams"]]);
    });
  });

  describe("retry on early crash", () => {
    it("respawns up to 3 attempts total, then gives up with the error visible", () => {
      const h = harness();
      h.servers.start("discord");
      crashAndRetry(h);
      crashAndRetry(h);
      crashAndRetry(h);
      expect(h.spawned).toHaveLength(3);
      expect(h.retries).toEqual([]);
      expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false, enabled: true, error: "exited with code 1" });
    });

    it("a clean exit is not retried", () => {
      const h = harness();
      h.servers.start("teams");
      h.procs[0]!.emit("exit", 0);
      expect(h.retries).toEqual([]);
    });

    it("stop during the retry delay cancels the respawn", () => {
      const h = harness();
      h.servers.start("discord");
      h.procs[0]!.emit("exit", 1);
      h.servers.stop("discord");
      h.flushRetries();
      expect(h.spawned).toHaveLength(1);
    });

    it("stopAll at quit cancels pending retries — a respawn then would be the orphan we kill for", () => {
      const h = harness();
      h.servers.start("teams");
      h.procs[0]!.emit("exit", 1);
      h.servers.stopAll();
      h.flushRetries();
      expect(h.spawned).toHaveLength(1);
    });

    it("a crash after the run was stable gets a fresh budget, not the leftover one", () => {
      const h = harness();
      h.servers.start("discord");
      crashAndRetry(h);
      crashAndRetry(h); // budget now spent: 3rd process is the last of this start
      h.advance(30_000);
      crashAndRetry(h); // ...but it served for 30s, so this crash starts over
      expect(h.spawned).toHaveLength(4);
      crashAndRetry(h);
      crashAndRetry(h);
      expect(h.spawned).toHaveLength(6);
      expect(h.retries).toEqual([]);
    });

    it("an explicit restart after giving up gets the full budget again", () => {
      const h = harness();
      h.servers.start("discord");
      crashAndRetry(h);
      crashAndRetry(h);
      crashAndRetry(h); // budget spent, nothing running
      expect(h.spawned).toHaveLength(3);
      h.servers.start("discord");
      crashAndRetry(h);
      crashAndRetry(h);
      expect(h.spawned).toHaveLength(6);
    });

    it("does not retry an unbuilt package — the retry can't fix a missing file", () => {
      const h = harness({ built: false });
      h.servers.start("teams");
      expect(h.retries).toEqual([]);
      expect(h.spawned).toEqual([]);
    });
  });
});
