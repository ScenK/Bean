import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chatopsEnabledFile } from "@bean/core";
import { startBots } from "../src/bots.js";
import { loadChatopsEnabled, saveChatopsEnabled } from "../src/chatops-enabled-store.js";
import type { SpawnedProcess } from "../src/chatops-servers.js";
import { createTaskStatus } from "../src/task-status.js";

function boot(dir: string, opts: { legacyEnabledFile?: string; configs?: string[] } = {}) {
  const quit: (() => void)[] = [];
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; killed: boolean }[] = [];
  const configs = new Set((opts.configs ?? ["discord", "teams"]).map((b) => join(dir, `${b}.json`)));
  const onEvent = vi.fn();
  const bots = startBots({
    dir, builtinDir: "/builtin", root: "/repo", resolvedPath: "/usr/bin",
    taskStatus: createTaskStatus(() => {}), onQuit: (fn) => quit.push(fn),
    onRoutineTrigger: async () => ({ status: "refused", reason: "unavailable" }),
    onEvent, onSynced: vi.fn(),
    ...(opts.legacyEnabledFile ? { legacyEnabledFile: opts.legacyEnabledFile } : {}),
    // Server bundles always "built"; config files exist only for the bots listed.
    existsFn: (p) => !p.endsWith(".json") || configs.has(p),
    spawnFn: (_cmd, args, _cwd, env) => {
      const rec = { args, env, killed: false };
      spawned.push(rec);
      const exits: ((code: number | null, signal: string | null) => void)[] = [];
      const proc: SpawnedProcess = {
        stderr: null,
        on: ((event: string, cb: (code: number | null, signal: string | null) => void) => { if (event === "exit") exits.push(cb); }) as SpawnedProcess["on"],
        send: () => true,
        kill: () => { rec.killed = true; for (const cb of exits) cb(0, null); },
      };
      return proc;
    },
  });
  return { bots, quit, spawned, onEvent };
}

it("migrates the legacy userData set once, autostarts it, and kills every bot on host quit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-bots-"));
  const legacy = join(mkdtempSync(join(tmpdir(), "bean-userdata-")), "chatops-enabled.json");
  await saveChatopsEnabled(legacy, ["discord", "teams"]);
  const { bots, quit, spawned } = boot(dir, { legacyEnabledFile: legacy });
  const b = await bots;
  expect(spawned.map((s) => s.args[0])).toEqual(["/repo/packages/discord/dist/server.js", "/repo/packages/teams/dist/server.js"]);
  expect(spawned[0]!.env.BEAN_BUILTIN_DIR).toBe("/builtin");
  expect(await loadChatopsEnabled(chatopsEnabledFile(dir))).toEqual(["discord", "teams"]);
  for (const fn of quit) fn();
  expect(spawned.every((s) => s.killed)).toBe(true);
  // Quit is not the user switching them off: the set survives for the next boot.
  await new Promise((r) => setTimeout(r, 10));
  expect(await loadChatopsEnabled(chatopsEnabledFile(dir))).toEqual(["discord", "teams"]);
  expect(b.status().discord).toEqual({ running: false, enabled: true });
});

it("doesn't spawn a bot whose config file is missing, but keeps its switch on so it can be stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-bots-"));
  writeFileSync(chatopsEnabledFile(dir), JSON.stringify({ enabled: ["teams"] }));
  const { bots, spawned } = boot(dir, { configs: ["discord"] });
  const b = await bots;
  expect(spawned).toEqual([]);
  expect(b.status().teams).toEqual({ running: false, enabled: true, error: expect.stringContaining(join(dir, "teams.json")) });
  b.stop("teams");
  expect(b.status().teams.enabled).toBe(false);
});
