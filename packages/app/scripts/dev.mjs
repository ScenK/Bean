// Dev orchestrator: keeps @bean/core and @bean/app's bundles rebuilt on change,
// and relaunches Electron whenever the bundled dist/ output changes.
import { spawn } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createDevProcessManager } from "./dev-processes.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(appDir, "dist");
mkdirSync(distDir, { recursive: true });

const processes = createDevProcessManager();
// NOT detached (no own process group) on purpose: children stay in our process group so a
// terminal Ctrl+C (SIGINT to the foreground group) reaches every one of them — tsc, esbuild,
// and Electron — directly. Detaching them shields them from Ctrl+C, and since pnpm kills this
// orchestrator before its own SIGINT handler runs, they'd orphan. See
// safety-dev-children-not-detached.md.
const spawnInherited = (cmd, args) => processes.track(spawn(cmd, args, { stdio: "inherit", cwd: appDir }));
const shutdown = () => { processes.killAll(); process.exit(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => processes.killAll());

// Rebuild @bean/core's dist as its source changes.
spawnInherited("pnpm", ["--filter", "@bean/core", "exec", "tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);

// Rebuild main/preload/renderer bundles as app source changes.
spawnInherited("node", ["esbuild.config.mjs", "--watch"]);

let child;
function launchElectron() {
  const start = () => {
    child = processes.track(spawn(electron, [join(distDir, "main.js")], { stdio: "inherit", cwd: appDir }));
    // dist/main.js may not exist yet on the very first tick; the next dist change re-triggers this.
    child.on("error", () => {});
  };
  // The app holds a single-instance lock: spawning the replacement before the old process has
  // fully exited makes the new one see the lock as taken and immediately kill itself.
  if (child && child.exitCode === null && !child.killed) {
    child.once("exit", start);
    child.kill();
  } else {
    start();
  }
}

// ponytail: naive whole-dir debounce, per-file granularity isn't worth it for a dev watcher
let timer;
watch(distDir, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(launchElectron, 200);
});

launchElectron();
