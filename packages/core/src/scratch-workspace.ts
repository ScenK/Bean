import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractPageText } from "./web-page.js";
import { isSafeRemoteUrl } from "./url-sniff.js";
import type { UrlKind } from "./url-sniff.js";

export function scratchDir(beanDirPath: string): string {
  return join(beanDirPath, "workspace");
}

/** Filesystem-safe, stable-per-URL slug so repeat runs against the same URL reuse the same
 * scratch dir instead of re-cloning/re-fetching every time. */
export function slugForUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return stripped.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "scratch";
}

// Async (not spawnSync) — a clone is a network call and would otherwise block Electron's
// main process for its whole duration.
export type ScratchSpawnFn = (command: string, args: string[], cwd: string) => Promise<void>;
const defaultSpawn: ScratchSpawnFn = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });

export type FetchTextFn = (url: string) => Promise<string>;
const defaultFetchText: FetchTextFn = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`fetch failed with HTTP ${res.status}`);
  return res.text();
};

export type PathExistsFn = (path: string) => Promise<boolean>;
const defaultPathExists: PathExistsFn = (path) => stat(path).then(() => true, () => false);

/** Turns a "no project" URL seed into a real local path for the run: a shallow clone for a
 * repo, or the page's extracted text written to a scratch file for a page. Reuses the same
 * path on repeat runs against the same URL (slugForUrl) — an already-cloned repo is left as
 * is rather than re-cloned into an existing dir (which git rejects). Rejects unsafe URLs
 * before any git/fetch IO (defense in depth over sniffUrl; see isSafeRemoteUrl). */
export async function prepareScratchWorkspace(
  url: string,
  kind: Exclude<UrlKind, "unknown">,
  beanDirPath: string,
  spawnFn: ScratchSpawnFn = defaultSpawn,
  fetchText: FetchTextFn = defaultFetchText,
  pathExists: PathExistsFn = defaultPathExists,
): Promise<string> {
  if (!isSafeRemoteUrl(url)) throw new Error(`Refusing to fetch unsafe URL: ${url}`);
  const dir = scratchDir(beanDirPath);
  await mkdir(dir, { recursive: true });
  const slug = slugForUrl(url);

  if (kind === "repo") {
    const dest = join(dir, slug);
    // Reuse an existing checkout rather than cloning onto it (git clone requires the dest to
    // be empty/absent). ponytail: reuse only, no `git pull` refresh — add if staleness bites.
    if (!(await pathExists(dest))) {
      await spawnFn("git", ["clone", "--depth", "1", url, dest], dir);
    }
    return dest;
  }

  const text = extractPageText(await fetchText(url));
  const dest = join(dir, `${slug}.md`);
  await writeFile(dest, text, "utf8");
  return dir;
}
