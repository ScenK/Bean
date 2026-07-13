import { describe, expect, it } from "vitest";
import { createChatopsServers, type ChatopsEvent, type SpawnedProcess } from "../src/chatops-servers.js";

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

function harness() {
  const sent: ChatopsEvent[] = [];
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  const procs: ReturnType<typeof fakeProcess>[] = [];
  const servers = createChatopsServers({
    repoRoot: "/repo",
    resolvedPath: "/usr/bin",
    send: (e) => sent.push(e),
    existsFn: () => true,
    spawnFn: (command, args, cwd) => {
      spawned.push({ command, args, cwd });
      const p = fakeProcess();
      procs.push(p);
      return p.proc;
    },
  });
  return { servers, sent, spawned, procs };
}

describe("createChatopsServers", () => {
  it("start spawns the built server entry under Electron's own node and emits running", () => {
    const h = harness();
    h.servers.start("discord");
    expect(h.spawned).toEqual([{ command: process.execPath, args: ["/repo/packages/discord/dist/server.js"], cwd: "/repo" }]);
    expect(h.sent).toEqual([{ bot: "discord", running: true }]);
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
    expect(sent).toEqual([{ bot: "discord", running: true }]);
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
    expect(sent).toEqual([{ bot: "teams", running: false, error: 'Not built — run "pnpm --filter @bean/teams build" first.' }]);
  });

  it("exit with a non-zero code surfaces the last stderr line as the error", () => {
    const h = harness();
    h.servers.start("discord");
    h.procs[0]!.emit("data", Buffer.from("boom: missing config\n"));
    h.procs[0]!.emit("exit", 1);
    expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false, error: "boom: missing config" });
  });

  it("clean exit (code 0) clears running with no error", () => {
    const h = harness();
    h.servers.start("teams");
    h.procs[0]!.emit("exit", 0);
    expect(h.sent.at(-1)).toEqual({ bot: "teams", running: false });
  });

  it("stop kills the tracked process; stopping an untracked bot is a no-op", () => {
    const h = harness();
    h.servers.start("discord");
    h.servers.stop("discord");
    expect(h.sent.at(-1)).toEqual({ bot: "discord", running: false });
    expect(() => h.servers.stop("teams")).not.toThrow();
  });

  it("status reflects the current state of both bots", () => {
    const h = harness();
    h.servers.start("discord");
    expect(h.servers.status()).toEqual({ discord: { running: true }, teams: { running: false } });
  });

  it("stopAll kills every running process", () => {
    const h = harness();
    h.servers.start("discord");
    h.servers.start("teams");
    h.servers.stopAll();
    expect(h.servers.status()).toEqual({ discord: { running: false }, teams: { running: false } });
  });
});
