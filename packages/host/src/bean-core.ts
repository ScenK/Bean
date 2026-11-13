#!/usr/bin/env node
// bean-core (#806): the host with no Electron and no required chat bot — the sprout scheduler and
// reminders under the bean.db lease, plus the Discord / Teams bots whose config files exist.
// Native (launchd / systemd) and in the container; setup in docs/headless.md.
// `bean-core attach` (#809) instead pipes stdio to a running bean-core's socket, for a shell over SSH.
// `bean-core --version` (#835) prints the core and contract versions and touches nothing (no ~/.bean,
// TZ or config): it is the installer's preflight.
import { beanDir, configFile, coreSocketFile, ensurePrivateBeanDir, loadRoutines, projectBeanDir, routinesDir } from "@bean/core";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { buildHandshake, CONTRACT_VERSION } from "./contract.js";
import { createHost } from "./host.js";
import { botLogger, cliAuthPresent, configuredBots, jobLogger, ownerNotices, tzProblem } from "./headless.js";
import { attachStdio, listenRemote } from "./remote.js";

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

// The remote attach socket (#809). No socket = no remote shells; the scheduler and bots still run.
try {
  const remote = await listenRemote(dir, {
    // No host capabilities headless (no Terminal.app, pty or path opens).
    handshake: buildHandshake(version, process.platform, []),
    attachments: host.attachments,
    handlers: host.handlers,
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
