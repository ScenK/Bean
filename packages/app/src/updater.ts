import { app } from "electron";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp as mkdtempCb, writeFile as writeFileCb, rename as renameCb, rm as rmCb, cp as cpCb } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GithubReleaseInfo } from "@bean/core";

const execFile = promisify(execFileCb);
const REPO = "ScenK/Bean";

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<GithubReleaseInfo> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const json = await res.json() as {
    tag_name: string;
    body: string;
    assets: { name: string; browser_download_url: string }[];
  };
  return {
    tagName: json.tag_name,
    body: json.body,
    assets: json.assets.map((a) => ({ name: a.name, browserDownloadUrl: a.browser_download_url })),
  };
}

export async function downloadAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface ExtractDeps {
  mkdtemp?: () => Promise<string>;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  runCodesignAndDitto?: (cmd: string, args: string[]) => Promise<void>;
}

/** Extracts a downloaded update zip and ad-hoc re-signs the bundle (same command as
 * scripts/after-sign.mjs uses at build time) so macOS will execute it. Returns the path to
 * the extracted, signed Bean.app inside a fresh temp directory. */
export async function extractAndSign(zipBuffer: Buffer, deps: ExtractDeps = {}): Promise<string> {
  const mkdtemp = deps.mkdtemp ?? (() => mkdtempCb(join(tmpdir(), "bean-update-")));
  const writeFile = deps.writeFile ?? ((p, d) => writeFileCb(p, d));
  const run = deps.runCodesignAndDitto ?? (async (cmd, args) => { await execFile(cmd, args); });

  const dir = await mkdtemp();
  const zipPath = join(dir, "Bean-update.zip");
  await writeFile(zipPath, zipBuffer);
  await run("ditto", ["-x", "-k", zipPath, dir]);
  const appPath = join(dir, "Bean.app");
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  return appPath;
}

/** Walks up from the running Electron binary's path to its enclosing .app bundle root
 * (".../Bean.app/Contents/MacOS/Bean" -> ".../Bean.app"). */
export function currentAppBundlePath(execPath: string = app.getPath("exe")): string {
  return dirname(dirname(dirname(execPath)));
}

export interface InstallDeps {
  currentAppPath?: string;
  rename?: (from: string, to: string) => Promise<void>;
  copyRecursive?: (from: string, to: string) => Promise<void>;
  rm?: (path: string) => Promise<void>;
  relaunch?: () => void;
  exit?: () => void;
}

/** Swaps the extracted update bundle into the currently-running app's path — the same
 * rename-dance Sparkle/Squirrel use — then relaunches. Rolls back if the swap itself fails,
 * so the install path is never left without an app bundle. */
export async function installAndRelaunch(extractedAppPath: string, deps: InstallDeps = {}): Promise<void> {
  const currentAppPath = deps.currentAppPath ?? currentAppBundlePath();
  const rename = deps.rename ?? ((from, to) => renameCb(from, to));
  const copyRecursive = deps.copyRecursive ?? ((from, to) => cpCb(from, to, { recursive: true }));
  const rm = deps.rm ?? ((p) => rmCb(p, { recursive: true, force: true }));
  const relaunch = deps.relaunch ?? (() => app.relaunch());
  const exit = deps.exit ?? (() => app.exit());

  const backupPath = `${currentAppPath}.old`;
  await rename(currentAppPath, backupPath);

  try {
    try {
      await rename(extractedAppPath, currentAppPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        await copyRecursive(extractedAppPath, currentAppPath);
        await rm(extractedAppPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    await rename(backupPath, currentAppPath);
    throw err;
  }

  await rm(backupPath).catch(() => {});
  relaunch();
  exit();
}
