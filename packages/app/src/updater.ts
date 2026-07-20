import { app } from "electron";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp as mkdtempCb, writeFile as writeFileCb } from "node:fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  checkForUpdate, verifyUpdateSignature, UPDATE_PUBLIC_KEY_PEM,
  type GithubReleaseInfo, type UpdateCheckResult,
} from "@bean/core";

const execFile = promisify(execFileCb);
const REPO = "ScenK/Bean";

// Electron's main process patches `fs` so `*.asar` paths behave like read-only directories.
// A recursive rm/cp over an app bundle then walks INTO app.asar, fails on its virtual
// entries, and leaves a Bean.app.old skeleton behind (Contents/Resources/app.asar was
// undeletable). `original-fs` is Electron's unpatched fs — use it for every whole-bundle
// operation; fall back to plain node:fs when not running under Electron (unit tests).
function bundleFs(): Pick<typeof nodeFsPromises, "rename" | "rm" | "cp"> {
  try {
    return (createRequire(import.meta.url)("original-fs") as typeof import("node:fs")).promises;
  } catch {
    return nodeFsPromises;
  }
}
const bfs = bundleFs();

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
 * rename-dance Sparkle/Squirrel use — then relaunches. Clears any leftover `.old` backup
 * first (avoids ENOTEMPTY on macOS), and rolls back if the swap itself fails so the
 * install path is never left without an app bundle. */
export async function installAndRelaunch(extractedAppPath: string, deps: InstallDeps = {}): Promise<void> {
  const currentAppPath = deps.currentAppPath ?? currentAppBundlePath();
  const rename = deps.rename ?? ((from, to) => bfs.rename(from, to));
  const copyRecursive = deps.copyRecursive ?? ((from, to) => bfs.cp(from, to, { recursive: true }));
  const rm = deps.rm ?? ((p) => bfs.rm(p, { recursive: true, force: true }));
  const relaunch = deps.relaunch ?? (() => app.relaunch());
  const exit = deps.exit ?? (() => app.exit());

  const backupPath = `${currentAppPath}.old`;
  // A leftover .old from a previous install (cleanup failed, or the process died mid-swap)
  // makes rename(current → .old) throw ENOTEMPTY on macOS. A recursive `rm` in place can
  // itself silently fail on a leftover with a permission-restricted file deep inside (needs
  // write access to every descendant) — swallowing that error left the destination still
  // occupied and the rename below threw the same ENOTEMPTY anyway. Renaming the leftover
  // aside first only needs permission on the directory entry itself, so it always frees the
  // destination; the displaced copy is then deleted best-effort since nothing depends on it.
  const staleBackupPath = `${backupPath}.stale-${randomUUID()}`;
  let hadStaleBackup = true;
  try {
    await rename(backupPath, staleBackupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    hadStaleBackup = false;
  }
  if (hadStaleBackup) await rm(staleBackupPath).catch(() => {});
  await rename(currentAppPath, backupPath);

  try {
    await rename(extractedAppPath, currentAppPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      // rename() failed before touching currentAppPath — it's still empty/nonexistent,
      // so the restore is always safe.
      await rename(backupPath, currentAppPath);
      throw err;
    }
    try {
      await copyRecursive(extractedAppPath, currentAppPath);
    } catch (copyErr) {
      // The copy may have partially populated currentAppPath — clear it before restoring
      // the backup so the restore-rename can't collide with a non-empty/partial destination.
      await rm(currentAppPath).catch(() => {});
      await rename(backupPath, currentAppPath);
      throw copyErr;
    }
    // Copy succeeded — the swap is done. Everything below is best-effort cleanup and must
    // never roll back an already-successful install.
  }

  await rm(backupPath).catch(() => {});
  await rm(dirname(extractedAppPath)).catch(() => {});
  relaunch();
  exit();
}

export interface CleanupDeps {
  rm?: (path: string) => Promise<void>;
}

/** Best-effort removes the temp directory `extractAndSign` created for a downloaded update
 * (the extracted app plus the zip it came from) — call this when a previously-downloaded,
 * not-yet-installed update is superseded by a newer check, so repeated "Check for Updates"
 * clicks don't silently accumulate ~125MB of orphaned /tmp directories. Never throws. */
export async function cleanupExtractedBundle(extractedAppPath: string, deps: CleanupDeps = {}): Promise<void> {
  const rm = deps.rm ?? ((p) => bfs.rm(p, { recursive: true, force: true }));
  await rm(dirname(extractedAppPath)).catch(() => {});
}

export interface UpdateCheckOutcome {
  result: UpdateCheckResult;
  extractedAppPath?: string;
}

export interface CheckAndDownloadDeps {
  fetchRelease?: () => Promise<GithubReleaseInfo>;
  downloadAsset?: (url: string) => Promise<Buffer>;
  extract?: (zipBuffer: Buffer) => Promise<string>;
  publicKeyPem?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Composes the full manual-update pipeline: fetch the latest release, decide if it's newer,
 * download + verify the zip's signature, and extract+sign it — everything up to (not
 * including) the actual install swap, which is a separate explicit user confirmation. */
export async function checkAndDownloadUpdate(currentVersion: string, deps: CheckAndDownloadDeps = {}): Promise<UpdateCheckOutcome> {
  const fetchRelease = deps.fetchRelease ?? fetchLatestRelease;
  const download = deps.downloadAsset ?? downloadAsset;
  const extract = deps.extract ?? extractAndSign;
  const publicKeyPem = deps.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM;

  let release: GithubReleaseInfo;
  try {
    release = await fetchRelease();
  } catch (err) {
    return { result: { status: "error", message: `Couldn't reach GitHub: ${errorMessage(err)}` } };
  }

  const check = checkForUpdate(currentVersion, release);
  if (check.status !== "available") return { result: check };

  let zipBuffer: Buffer;
  let sigBuffer: Buffer;
  try {
    [zipBuffer, sigBuffer] = await Promise.all([download(check.zipUrl), download(check.sigUrl)]);
  } catch (err) {
    return { result: { status: "error", message: `Download failed: ${errorMessage(err)}` } };
  }

  const signatureBase64 = sigBuffer.toString("utf8").trim();
  if (!verifyUpdateSignature(zipBuffer, signatureBase64, publicKeyPem)) {
    return { result: { status: "error", message: "Update signature verification failed — this release may be corrupted or tampered with." } };
  }

  let extractedAppPath: string;
  try {
    extractedAppPath = await extract(zipBuffer);
  } catch (err) {
    return { result: { status: "error", message: `Couldn't prepare the update: ${errorMessage(err)}` } };
  }

  return { result: check, extractedAppPath };
}
