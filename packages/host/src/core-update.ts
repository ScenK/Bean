// The core's self-update (#837): download, verify, check busy, swap, restart — one code path behind
// `bean-core update` (and the shell's remote ops, #838). Order, and why there's no drain queue:
// .memory/convention-core-self-update.md. Layout (install.sh, #836): <root>/versions/<ver>/ behind
// `current` and `previous` symlinks; the service runs `current`, so an update is a link flip plus
// an exit that launchd / systemd restarts.
import {
  checkCorePreflight, checkForCoreUpdate, verifyUpdateSignature, UPDATE_PUBLIC_KEY_PEM,
  type GithubReleaseInfo, type TrackedRun,
} from "@bean/core";
import { execFile } from "node:child_process";
import { mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TaskJob } from "./task-status.js";

/** The fixed release feed: an update takes no URL, path or key from its caller. */
export const RELEASES_URL = "https://api.github.com/repos/ScenK/Bean/releases/latest";
export const MAX_CORE_TARBALL_BYTES = 200 * 1024 * 1024;
const MAX_SIG_BYTES = 4096;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ENTRY = "packages/host/dist/bean-core.js";

/** What a start gets while the latch is closed. */
export const UPDATING = "Bean is updating — try again in a minute.";

/** install.sh's install root. */
export const installRoot = (home: string = homedir()): string => join(home, ".local", "share", "bean-core");

/** One piece of running work an update would stop. */
export interface BusyItem { kind: string; name: string }

/** Busy = any running job on the host (an open live session counts while it waits for input) or
 * any live run record (`~/.bean/runs/`, where the bots' runs show up). A record the host already
 * lists under its own id isn't listed twice. */
export function busyWork(jobs: readonly TaskJob[], runs: readonly TrackedRun[]): BusyItem[] {
  const running = jobs.filter((j) => j.state === "running");
  const items: BusyItem[] = running.map((j) => ({ kind: j.kind, name: j.name }));
  for (const r of runs) {
    if (running.some((j) => j.id === r.id || j.id.endsWith(`:${r.id}`))) continue;
    items.push({ kind: "run", name: basename(r.projectPath) || r.projectPath });
  }
  return items;
}

/** The running host's admission latch: closed, new delegate / live session / chat turn / sprout
 * starts are refused and the scheduler fires nothing. */
export interface CoreLatch { close: () => void; open: () => void; busy: () => BusyItem[] }

export type CoreUpdateResult =
  | { status: "up-to-date"; version: string }
  | { status: "busy"; version: string; busy: BusyItem[] }
  /** The links point at `version` and the latch stays closed: the caller exits now. */
  | { status: "updated"; from: string; version: string; stopped: BusyItem[] }
  | { status: "error"; message: string };

export interface CoreUpdateDeps {
  root: string;
  currentVersion: string;
  /** Require the new core to speak this contract (a shell's update: it must reattach). Unset = any
   * (`bean-core update` on the box — the recovery when a shell can't attach). */
  contract?: number;
  latch: CoreLatch;
  fetch?: typeof fetch;
  /** Runs a command to completion, resolving its stdout (tar, the preflight). */
  run?: (cmd: string, args: string[]) => Promise<string>;
  /** The Node the service runs (this process's). */
  node?: string;
  publicKeyPem?: string;
}

const defaultRun = (cmd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(cmd, args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 120_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${basename(cmd)} failed: ${(stderr.trim() || err.message).slice(0, 500)}`));
    else resolve(stdout);
  });
});

async function fetchRelease(f: typeof fetch): Promise<GithubReleaseInfo> {
  const res = await f(RELEASES_URL, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const json = await res.json() as { tag_name?: unknown; body?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };
  if (typeof json.tag_name !== "string" || !Array.isArray(json.assets)) throw new Error("GitHub sent a malformed release.");
  return {
    tagName: json.tag_name,
    body: typeof json.body === "string" ? json.body : "",
    assets: json.assets.flatMap((a) => (typeof a.name === "string" && typeof a.browser_download_url === "string"
      ? [{ name: a.name, browserDownloadUrl: a.browser_download_url }] : [])),
  };
}

/** The body, refused past `max` bytes (declared or streamed) before it is all buffered. */
async function download(f: typeof fetch, url: string, max: number): Promise<Buffer> {
  const res = await f(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tooBig = (): Error => new Error(`${url} is over ${max} bytes.`);
  if (Number(res.headers.get("content-length")) > max) throw tooBig();
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `ln -sfn` without a gap: a temp link renamed over the old one. */
function relink(root: string, name: string, target: string): void {
  const tmp = join(root, `.${name}.${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, join(root, name));
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Fetch the latest release → verify its signature (hard stop) → unpack to `versions/<new>` →
 * preflight its `--version`. Nothing running is touched until then. Then close the latch and check
 * busy: busy and not `force` → reopen and return the list; otherwise flip `previous` ← `current` ←
 * `<new>` and return "updated" with the latch still closed. Any failure reopens it. */
export async function updateCore(force: boolean, deps: CoreUpdateDeps): Promise<CoreUpdateResult> {
  const f = deps.fetch ?? fetch;
  const run = deps.run ?? defaultRun;
  const { root } = deps;
  let current: string;
  try { current = readlinkSync(join(root, "current")); } catch {
    return { status: "error", message: `This core wasn't installed with install.sh (no ${join(root, "current")}); update it the way it was installed.` };
  }

  let release: GithubReleaseInfo;
  try { release = await fetchRelease(f); } catch (err) { return { status: "error", message: `Couldn't reach GitHub: ${why(err)}` }; }
  const check = checkForCoreUpdate(deps.currentVersion, release);
  if (check.status !== "available") return check;
  const { version } = check;
  const target = `versions/${version}`;
  if (current === target) return { status: "up-to-date", version };

  let tar: Buffer;
  let sig: Buffer;
  try {
    [tar, sig] = await Promise.all([download(f, check.tarUrl, MAX_CORE_TARBALL_BYTES), download(f, check.sigUrl, MAX_SIG_BYTES)]);
  } catch (err) { return { status: "error", message: `Download failed: ${why(err)}` }; }
  if (!verifyUpdateSignature(tar, sig.toString("utf8").trim(), deps.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM)) {
    return { status: "error", message: `bean-core ${version}'s signature doesn't verify — nothing was changed.` };
  }

  const dest = join(root, target);
  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(join(root, "versions", ".update-"));
    writeFileSync(join(tmp, "core.tar.gz"), tar);
    await run("tar", ["-xzf", join(tmp, "core.tar.gz"), "-C", tmp]);
    rmSync(dest, { recursive: true, force: true }); // a copy from an earlier attempt, or `previous`
    renameSync(join(tmp, `bean-core-${version}`), dest);
  } catch (err) {
    return { status: "error", message: `Couldn't unpack bean-core ${version}: ${why(err)}` };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  let problem: string | undefined;
  try {
    problem = checkCorePreflight(await run(deps.node ?? process.execPath, [join(dest, ENTRY), "--version"]), {
      version, ...(deps.contract !== undefined ? { contract: deps.contract } : {}),
    });
  } catch (err) { problem = why(err); }
  if (problem) {
    rmSync(dest, { recursive: true, force: true });
    return { status: "error", message: `bean-core ${version} failed its preflight: ${problem}` };
  }

  deps.latch.close();
  try {
    const busy = deps.latch.busy();
    if (busy.length > 0 && !force) {
      deps.latch.open();
      return { status: "busy", version, busy };
    }
    relink(root, "previous", current);
    relink(root, "current", target);
    return { status: "updated", from: deps.currentVersion, version, stopped: busy };
  } catch (err) {
    deps.latch.open();
    return { status: "error", message: `Couldn't switch to bean-core ${version}: ${why(err)}` };
  }
}
