import { app } from "electron";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp as mkdtempCb, writeFile as writeFileCb } from "node:fs/promises";
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
