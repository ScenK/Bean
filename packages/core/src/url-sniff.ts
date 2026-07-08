import { spawn } from "node:child_process";

export type UrlKind = "repo" | "page" | "unknown";

/** Rejects anything we won't hand to git/fetch for a "no project" URL seed: non-http(s)
 * schemes (blocks file:, ssh:, etc. reading local content) and loopback/private/link-local
 * hosts (blocks probing internal services via a model- or user-supplied URL). The sourceUrl
 * reaches here from IPC and can be model-generated, so this is a trust boundary — validate
 * before any ls-remote/clone/fetch touches it. */
export function isSafeRemoteUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isPrivateHost(u.hostname);
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets
  if (host === "localhost" || host === "" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIpv4(v4.slice(1).map(Number));
  return false; // a DNS name we can't resolve here — allowed; the network call is the check
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true;
  if (a === 10 || a === 127 || a === 0) return true; // private, loopback, "this host"
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (host.startsWith("fe80")) return true; // link-local
  // IPv4-mapped (::ffff:a.b.c.d; Node normalizes to ::ffff:7f00:1 etc.) — reject the whole
  // mapped range so loopback/private IPv4 can't sneak in as IPv6 (e.g. ::ffff:127.0.0.1).
  if (host.startsWith("::ffff:")) return true;
  return /^f[cd][0-9a-f]{2}:/.test(host); // fc00::/7 unique-local
}

// Async git probe (not spawnSync) so a slow/unreachable remote can't block Electron's main
// process for the whole 3s timeout on every debounced keystroke.
export type GitLsRemoteFn = (url: string) => Promise<boolean>;
const defaultGitLsRemote: GitLsRemoteFn = (url) =>
  new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", "--exit-code", url], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && out.trim() !== ""); });
  });

export type FetchHeadFn = (url: string) => Promise<{ ok: boolean; contentType: string | null }>;
const defaultFetchHead: FetchHeadFn = async (url) => {
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
  return { ok: res.ok, contentType: res.headers.get("content-type") };
};

/** Distinguishes a git-clonable repo URL from a regular web page for the 2a "no project"
 * flow: `git ls-remote` is cheap and authoritative for the repo case; falling back to an
 * HTML-content-type HEAD request for the page case. An unsafe URL, or neither reachable =
 * "unknown" (the mockup's "unreachable — will retry at run time" badge). */
export async function sniffUrl(
  url: string,
  gitLsRemote: GitLsRemoteFn = defaultGitLsRemote,
  fetchHead: FetchHeadFn = defaultFetchHead,
): Promise<UrlKind> {
  if (!isSafeRemoteUrl(url)) return "unknown";
  try {
    if (await gitLsRemote(url)) return "repo";
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
