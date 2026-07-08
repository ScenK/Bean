import { spawnSync } from "node:child_process";
import type { SpawnSyncFn } from "./launcher.js";

export type UrlKind = "repo" | "page" | "unknown";

const defaultSpawnSync: SpawnSyncFn = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 3000 });

export type FetchHeadFn = (url: string) => Promise<{ ok: boolean; contentType: string | null }>;
const defaultFetchHead: FetchHeadFn = async (url) => {
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
  return { ok: res.ok, contentType: res.headers.get("content-type") };
};

/** Distinguishes a git-clonable repo URL from a regular web page for the 2a "no project"
 * flow: `git ls-remote` is cheap and authoritative for the repo case; falling back to an
 * HTML-content-type HEAD request for the page case. Neither reachable = "unknown" (the
 * mockup's "unreachable — will retry at run time" badge). */
export async function sniffUrl(
  url: string,
  spawnSyncFn: SpawnSyncFn = defaultSpawnSync,
  fetchHead: FetchHeadFn = defaultFetchHead,
): Promise<UrlKind> {
  try {
    const res = spawnSyncFn("git", ["ls-remote", "--exit-code", url]);
    if (typeof res.stdout === "string" && res.stdout.trim() !== "") return "repo";
  } catch {
    // fall through to the page check
  }
  try {
    const head = await fetchHead(url);
    if (head.ok && (head.contentType ?? "").includes("html")) return "page";
  } catch {
    // fall through to unknown
  }
  return "unknown";
}
