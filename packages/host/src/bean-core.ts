#!/usr/bin/env node
// bean-core (#806): the host with no Electron and no required chat bot — the sprout scheduler and
// reminders under the bean.db lease, plus the Discord / Teams bots whose config files exist.
// Native (launchd / systemd) and in the container; setup in docs/headless.md.
import { beanDir, configFile, ensurePrivateBeanDir, loadRoutines, projectBeanDir, routinesDir } from "@bean/core";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { createHost } from "./host.js";
import { botLogger, cliAuthPresent, configuredBots, jobLogger, ownerNotices, tzProblem } from "./headless.js";

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
