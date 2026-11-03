// node-pty 1.1.0's npm tarball ships prebuilds/<platform>/spawn-helper as mode 644, and without +x
// every spawn fails with `posix_spawnp failed`. Run as `postinstall` (dev: node_modules) and as
// electron-builder's `afterPack` hook (packaged: app.asar.unpacked, before afterSign codesigns).
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** chmod +x every prebuilt spawn-helper under `ptyDir`; returns how many it found. */
export function makeSpawnHelpersExecutable(ptyDir) {
  const prebuilds = join(ptyDir, "prebuilds");
  if (!existsSync(prebuilds)) return 0;
  let n = 0;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) { chmodSync(helper, 0o755); n++; }
  }
  return n;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const ptyDir = join(app, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty");
  // Fail the build rather than ship a terminal that can never spawn.
  if (makeSpawnHelpersExecutable(ptyDir) === 0) throw new Error(`no node-pty spawn-helper under ${ptyDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  makeSpawnHelpersExecutable(fileURLToPath(new URL("../node_modules/node-pty", import.meta.url)));
}
