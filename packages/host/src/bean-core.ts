#!/usr/bin/env node
// bean-core (#806): the host with no Electron and no required chat bot — the sprout scheduler and
// reminders under the bean.db lease, plus the Discord / Teams bots whose config files exist.
// Native (launchd / systemd) and in the container; setup in docs/headless.md.
// `bean-core attach` (#809) instead pipes stdio to a running bean-core's socket, for a shell over SSH.
// `bean-core --version` (#835) prints the core and contract versions and touches nothing (no ~/.bean,
// TZ or config): it is the installer's preflight.
// `bean-core update [--yes]` (#837) asks the running core to update itself (it does the busy check);
// with no core listening it updates in-process and restarts the service.
import { beanDir, configFile, coreSocketFile, ensurePrivateBeanDir, liveRuns, loadRoutines, projectBeanDir, routinesDir } from "@bean/core";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { buildHandshake, CONTRACT_VERSION } from "./contract.js";
import { busyWork, installRoot, updateCore, type CoreUpdateResult } from "./core-update.js";
import { createHost } from "./host.js";
import { botLogger, cliAuthPresent, configuredBots, jobLogger, ownerNotices, tzProblem } from "./headless.js";
import { attachStdio, listenRemote, requestUpdate } from "./remote.js";

// Set by the esbuild bundle (the app's version, so a shell and a core from one release match).
const version = process.env.BEAN_CORE_VERSION ?? "dev";

if (process.argv[2] === "--version") {
  console.log(`bean-core ${version} contract ${CONTRACT_VERSION}`);
  process.exit(0);
}

if (process.argv[2] === "attach") {
  const path = coreSocketFile(beanDir());
  try {
    await attachStdio(path, process.stdin, process.stdout);
    process.exit(0);
  } catch (err) {
    console.error(`bean-core attach: no bean-core is listening on ${path} (${(err as Error).message}).`);
    process.exit(1);
  }
}

if (process.argv[2] === "update") process.exit(await updateCommand(process.argv.includes("--yes")));

/** `bean-core update`: 0 when up to date or updated, 1 otherwise. */
async function updateCommand(yes: boolean): Promise<number> {
  const dir = beanDir();
  const attempt = async (force: boolean): Promise<{ r: CoreUpdateResult; inProcess: boolean }> => {
    const r = await requestUpdate(coreSocketFile(dir), force);
    if (r) return { r, inProcess: false };
    // No core listening: nothing of the core is running, only a bot's orphaned run could be.
    const latch = { close: () => {}, open: () => {}, busy: () => busyWork([], liveRuns(dir)) };
    return { r: await updateCore(force, { root: installRoot(), currentVersion: version, latch }), inProcess: true };
  };
  let { r, inProcess } = await attempt(yes);
  if (r.status === "busy") {
    console.log(`bean-core ${r.version} is available, but the core is busy:`);
    for (const b of r.busy) console.log(`  - ${b.kind}: ${b.name}`);
    if (!process.stdin.isTTY) {
      console.log("Re-run with --yes to stop them and update.");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y(es)?$/i.test((await rl.question("Stop them and update? [y/N] ")).trim());
    rl.close();
    if (!ok) return 1;
    ({ r, inProcess } = await attempt(true));
  }
  if (r.status === "up-to-date") console.log(`bean-core is up to date (${version}; latest release ${r.version}).`);
  else if (r.status === "error") console.error(`bean-core update: ${r.message}`);
  else if (r.status === "busy") console.error("bean-core update: the core is still busy.");
  else {
    console.log(`Updated bean-core ${r.from} → ${r.version}${r.stopped.length ? ` (stopped ${r.stopped.length} running job(s))` : ""}. \`bean-core rollback\` returns to ${r.from}.`);
    if (!inProcess) {
      console.log("The core is restarting on the new version.");
      return 0;
    }
    // No running core exited, so start the service on the new version (the new installer knows how).
    return spawnSync("/bin/sh", [`${installRoot()}/current/install.sh`, "--restart"], { stdio: "inherit" }).status ?? 1;
  }
  return r.status === "up-to-date" ? 0 : 1;
}

const tz = tzProblem(process.env);
if (tz) {
  console.error(tz);
  process.exit(1);
}
const dir = beanDir();
ensurePrivateBeanDir(dir);
// createHost would bootstrap an empty one; a service should say what's missing instead.
if (!existsSync(configFile(dir))) {
  console.error(`bean-core: no config — create ${configFile(dir)} with { "openaiApiKey": "sk-..." }.`);
  process.exit(1);
}
// A service gets a minimal environment: the login-shell PATH probe (the desktop's CLI detection,
// safety-packaged-app-path-detection) needs the account's real shell, not the zsh default.
process.env.SHELL ||= userInfo().shell || "/bin/sh";
const builtinDir = process.env.BEAN_BUILTIN_DIR || projectBeanDir();

const quit: (() => void)[] = [];
let stopping = false;
const shutdown = (code: number): void => {
  if (stopping) return;
  stopping = true;
  for (const fn of quit) {
    try { fn(); } catch (err) { console.error("bean-core: shutdown step failed", err); }
  }
  process.exit(code);
};
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const host = await createHost({
  dir,
  builtinDir,
  push: () => {}, // no chat window attached
  onJobs: jobLogger(),
  notification: ownerNotices(dir),
  isChatClient: () => false,
  onQuit: (fn) => { quit.push(fn); },
  firstAutoMemory: async () => false,
  bots: {
    // The bundles sit beside this one: packages/{discord,teams}/dist in the checkout and the image.
    root: dirname(projectBeanDir()),
    onEvent: botLogger(),
    onSynced: () => {},
  },
  // Exit non-zero: the service manager restarts it, and the new process stands by for the lease.
  headless: { onLeaseLost: () => shutdown(1) },
});

// The self-update (#837): one at a time; "updated" leaves the latch closed and the process exits
// once the answer is out (or after a 5 s backstop, if the requester vanished).
let updateRunning = false;
const update = async (force: boolean): Promise<CoreUpdateResult> => {
  if (updateRunning) return { status: "error", message: "An update is already running." };
  updateRunning = true;
  const r = await updateCore(force, { root: installRoot(), currentVersion: version, latch: host.coreUpdate })
    .catch((err: unknown): CoreUpdateResult => ({ status: "error", message: err instanceof Error ? err.message : String(err) }));
  if (r.status === "updated") {
    console.log(`bean-core: updated to ${r.version}${r.stopped.length ? `, stopping ${r.stopped.length} running job(s)` : ""}; restarting.`);
    setTimeout(() => shutdown(0), 5_000);
  } else {
    updateRunning = false;
  }
  return r;
};

// The remote attach socket (#809). No socket = no remote shells; the scheduler and bots still run.
try {
  const remote = await listenRemote(dir, {
    // No host capabilities headless (no Terminal.app, pty or path opens).
    handshake: buildHandshake(version, process.platform, []),
    attachments: host.attachments,
    handlers: host.handlers,
    update,
    onUpdated: () => shutdown(0),
  });
  quit.push(remote.close);
} catch (err) {
  console.error(`bean-core: remote attach is off — ${(err as Error).message}`);
}

const bots = configuredBots(dir);
for (const bot of bots) host.bots.start(bot);

const clis = host.enabledClis();
const auth = clis.map((c) => `${c}=${cliAuthPresent(c, process.env, homedir()) ? "yes" : "no"}`).join(" ");
const routines = await loadRoutines(routinesDir(dir));
console.log(
  `bean-core on: TZ=${process.env.TZ}, data ${dir}, clis: ${clis.join(", ") || "none"} (auth ${auth || "n/a"}), ` +
    `${routines.length} sprout(s) (${routines.filter((r) => r.enabled).length} enabled), bots: ${bots.join(", ") || "none"}, ` +
    `scheduler ${host.schedulerLease.held() ? "on" : "standing by (another Bean holds the lease)"}`,
);
if (!host.runtime.getApiKey()) console.error(`bean-core: openaiApiKey is empty in ${configFile(dir)} — chat and model steps will fail.`);
