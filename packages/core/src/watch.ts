import type { RoutineWatch } from "./routine-store.js";

/** One item a watch sees. `id` is the dedupe key (feed entry id / command `id`). */
export interface WatchItem { id: string; text: string; link?: string }

export interface WatchPollDeps {
  /** GET a URL and return its body; rejects on network error or non-2xx. */
  fetchText: (url: string) => Promise<string>;
  /** Runs `command` in a shell; rejects on non-zero exit / timeout with a message that
   * includes stderr and the exit code. */
  exec: (command: string) => Promise<string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1]!.trim();
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** Bodies of every `<name …>…</name>` (case-insensitive; self-closing = ""), by a linear
 * indexOf scan — feed bodies come from the internet, so no backtracking regex over them
 * (CodeQL js/polynomial-redos). `pos` only moves forward. */
function elements(xml: string, name: string): string[] {
  const lower = xml.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}>`;
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) break;
    pos = start + open.length;
    if (!/[\s>/]/.test(lower[pos] ?? "")) continue; // <entryfoo>, <identity> …
    const openEnd = lower.indexOf(">", pos);
    if (openEnd < 0) break;
    if (lower[openEnd - 1] === "/") { out.push(""); pos = openEnd + 1; continue; }
    const end = lower.indexOf(close, openEnd);
    if (end < 0) break;
    out.push(xml.slice(openEnd + 1, end));
    pos = end + close.length;
  }
  return out;
}

const tag = (block: string, name: string): string | undefined => {
  const body = elements(block, name)[0];
  return body === undefined ? undefined : decode(body);
};

const attr = (el: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(el);
  return m ? decode(m[2] ?? m[3] ?? "") : undefined;
};

/** Atom `<entry>` (id = `<id>`) and RSS 2.0 `<item>` (id = `<guid>`), falling back to the link
 * when a feed omits the id. Hand parser on purpose — no XML dependency for two element shapes. */
export function parseFeed(xml: string): WatchItem[] {
  const items: WatchItem[] = [];
  const kind = /<entry[\s>]/i.test(xml) ? "entry" : "item"; // Atom or RSS — a feed is one or the other
  for (const body of elements(xml, kind)) {
    // Atom links are `<link href="…"/>` (prefer rel=alternate); RSS links are `<link>…</link>`.
    const atomLinks = [...body.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const atomLink = atomLinks.find((l) => !/rel\s*=/i.test(l) || /rel\s*=\s*["']alternate["']/i.test(l));
    const link = (atomLink ? attr(atomLink, "href") : undefined) || tag(body, "link") || undefined;
    const id = tag(body, "id") || tag(body, "guid") || link;
    if (!id) continue;
    items.push({ id, text: tag(body, "title") || link || id, ...(link ? { link } : {}) });
  }
  return items;
}

const isItem = (v: unknown): v is { id: unknown; text: unknown } =>
  typeof v === "object" && v !== null && "id" in v;

function toItem(v: unknown): WatchItem {
  if (!isItem(v)) throw new Error("each item must be an object with id and text");
  const id = typeof v.id === "string" || typeof v.id === "number" ? String(v.id) : "";
  if (!id) throw new Error("each item needs a non-empty id");
  const text = typeof v.text === "string" && v.text.trim() ? v.text.trim() : id;
  return { id, text };
}

/** The command contract: stdout is JSON lines or one JSON array, each `{id, text}`.
 * Empty stdout = nothing there. Anything else throws (surfaced as a poll error). */
export function parseCommandOutput(stdout: string): WatchItem[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error("output looked like a JSON array but didn't parse"); }
    if (!Array.isArray(parsed)) throw new Error("output must be a JSON array or JSON lines");
    return parsed.map(toItem);
  }
  return trimmed.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`line ${i + 1} is not JSON: ${line.slice(0, 80)}`); }
    return toItem(parsed);
  });
}

/** Finds a site's feed from its HTML: `<link rel="alternate" type="application/(rss|atom)+xml">`,
 * falling back to a YouTube channel id in `<link rel="canonical" href=".../channel/UC…">` (a bare
 * `youtube.com/@handle` URL has no channel id — the page has to be fetched). */
export function discoverFeedUrl(html: string, pageUrl: string): string | undefined {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const abs = (href: string): string | undefined => {
    try { return new URL(href, pageUrl).toString(); } catch { return undefined; }
  };
  for (const l of links) {
    if (!/rel\s*=\s*["']?alternate/i.test(l)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(l)) continue;
    const href = attr(l, "href");
    if (href) return abs(href);
  }
  for (const l of links) {
    if (!/rel\s*=\s*["']?canonical/i.test(l)) continue;
    const id = /\/channel\/(UC[\w-]+)/.exec(attr(l, "href") ?? "")?.[1];
    if (id) return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  }
  return undefined;
}

export const looksLikeFeed = (body: string): boolean => /<(rss|feed)[\s>]/i.test(body.slice(0, 2000));

export async function pollWatch(watch: RoutineWatch, deps: WatchPollDeps): Promise<WatchItem[]> {
  if (watch.kind === "command") return parseCommandOutput(await deps.exec(watch.command));
  const body = await deps.fetchText(watch.url);
  if (!looksLikeFeed(body)) {
    // A consent/interstitial page (e.g. consent.youtube.com) comes back as HTML with 200.
    throw new Error(`${watch.url} didn't return an RSS/Atom feed`);
  }
  return parseFeed(body);
}

/** What identifies a watch's source — changing it clears the seen-set (re-seed). */
export const watchSourceKey = (watch: RoutineWatch): string =>
  watch.kind === "feed" ? `feed:${watch.url.trim()}` : `command:${watch.command.trim()}`;

/** Notify-only digest: no model, one line (+ link) per new item. */
export const watchDigest = (items: WatchItem[]): string =>
  items.map((i) => `New: ${i.text}${i.link ? `\n${i.link}` : ""}`).join("\n\n");

/** Todo text for a queued item — the link rides along so the step can open it. */
export const watchTodoText = (item: WatchItem): string =>
  item.link && !item.text.includes(item.link) ? `${item.text}\n${item.link}` : item.text;
