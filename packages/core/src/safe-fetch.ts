import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Fetches steered by untrusted text (feed URLs, pages, queued todos) must not reach the host
// itself, the LAN, or a cloud metadata endpoint (169.254.169.254). The check runs on the
// *resolved* address inside the socket's own lookup, so the connection is pinned to the address
// that passed — no DNS-rebinding window between check and connect — and again on every redirect.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(net, prefix, "ipv6"); // BlockList matches IPv4-mapped IPv6 against the v4 rules

/** True for loopback, link-local, private, CGNAT, multicast/reserved, and IPv4-mapped IPv6. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an IP at all — refuse rather than guess
  return PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Test seam; defaults to `isPrivateAddress`. */
  isBlocked?: (address: string) => boolean;
}

export interface SafeFetchResult { status: number; ok: boolean; url: string; body: string }

/** GET `url` (http/https only), refusing private addresses after DNS resolution and on every
 * redirect hop. One deadline covers the whole chain + body; the body aborts past `maxBytes`. */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const isBlocked = opts.isBlocked ?? isPrivateAddress;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await get(current, isBlocked, signal);
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= (opts.maxRedirects ?? 5)) throw new Error("too many redirects");
      current = new URL(location, current);
      continue;
    }
    const status = res.statusCode ?? 0;
    const body = await readCapped(res, opts.maxBytes);
    return { status, ok: status >= 200 && status < 300, url: current.toString(), body };
  }
}

function get(url: URL, isBlocked: (address: string) => boolean, signal: AbortSignal): Promise<IncomingMessage> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error(`only http(s) URLs can be fetched, got ${url.protocol}`));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // An IP literal never goes through `lookup`, so check it here.
  if (isIP(host) && isBlocked(host)) return Promise.reject(refused(host, url.hostname));
  const lookup: LookupFunction = (hostname, options, cb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) { cb(err, "", 0); return; }
      const bad = addresses.find((a) => isBlocked(a.address));
      if (bad) { cb(refused(bad.address, hostname), "", 0); return; }
      const first = addresses[0];
      if (!first) { cb(new Error(`no address for ${hostname}`), "", 0); return; }
      if (options.all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else cb(null, first.address, first.family);
    });
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", lookup, signal, headers: { "user-agent": "Bean" } }, resolve);
    req.on("error", reject);
    req.end();
  });
}

const refused = (address: string, host: string): Error =>
  new Error(`refusing to fetch ${host}: ${address} is a private/loopback/link-local address`);

async function readCapped(res: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > max) {
      res.destroy();
      throw new Error(`response is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
