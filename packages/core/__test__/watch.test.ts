import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWatch, countSeen, describeRoutineError, discoverFeedUrl, isWatchSeeded, loadRoutineStates, markNewItems,
  parseCommandOutput, parseFeed, pollWatch, saveRoutineStates, seedWatch, watchDigest, watchSourceKey, WATCH_SEEN_CAP,
  type Routine,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <id>yt:channel:UCabc</id><title>Channel</title>
  <entry><id>yt:video:v1</id><yt:videoId>v1</yt:videoId><title>First &amp; best</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=v1"/></entry>
  <entry><id>yt:video:v2</id><title><![CDATA[Second <3]]></title><link href="https://www.youtube.com/watch?v=v2"/></entry>
</feed>`;

const RSS = `<rss version="2.0"><channel><title>Blog</title>
  <item><title>Post A</title><link>https://blog.example/a</link><guid isPermaLink="false">a-1</guid></item>
  <item><title>Post B</title><link>https://blog.example/b</link></item>
</channel></rss>`;

describe("parseFeed", () => {
  it("reads Atom entries by <id>, with title and alternate link", () => {
    expect(parseFeed(ATOM)).toEqual([
      { id: "yt:video:v1", text: "First & best", link: "https://www.youtube.com/watch?v=v1" },
      { id: "yt:video:v2", text: "Second <3", link: "https://www.youtube.com/watch?v=v2" },
    ]);
  });
  it("reads RSS 2.0 items by <guid>, falling back to the link", () => {
    expect(parseFeed(RSS)).toEqual([
      { id: "a-1", text: "Post A", link: "https://blog.example/a" },
      { id: "https://blog.example/b", text: "Post B", link: "https://blog.example/b" },
    ]);
  });
});

describe("parseCommandOutput", () => {
  it("accepts JSON lines and a single JSON array", () => {
    const lines = '{"id":"1","text":"one"}\n{"id":2,"text":"two"}\n';
    expect(parseCommandOutput(lines)).toEqual([{ id: "1", text: "one" }, { id: "2", text: "two" }]);
    expect(parseCommandOutput('[{"id":"x","text":"ex"}]')).toEqual([{ id: "x", text: "ex" }]);
  });
  it("treats empty output as nothing there", () => {
    expect(parseCommandOutput("  \n")).toEqual([]);
  });
  it("rejects output that breaks the contract", () => {
    expect(() => parseCommandOutput("hello")).toThrow(/line 1 is not JSON/);
    expect(() => parseCommandOutput('{"text":"no id"}')).toThrow(/id/);
  });
});

describe("pollWatch", () => {
  it("runs the command and surfaces a non-zero exit as a poll error", async () => {
    const ok = await pollWatch({ kind: "command", command: "x" }, { fetchText: async () => "", exec: async () => '{"id":"a","text":"A"}' });
    expect(ok).toEqual([{ id: "a", text: "A" }]);
    await expect(pollWatch({ kind: "command", command: "x" }, {
      fetchText: async () => "", exec: async () => { throw new Error("gh auth login (exit 4)"); },
    })).rejects.toThrow("exit 4");
  });
  it("fails a feed that returned an HTML page instead (consent wall)", async () => {
    await expect(pollWatch({ kind: "feed", url: "https://y.example/f" }, {
      fetchText: async () => "<html><body>Before you continue</body></html>", exec: async () => "",
    })).rejects.toThrow(/RSS\/Atom/);
  });
});

describe("discoverFeedUrl", () => {
  it("finds the rel=alternate feed link", () => {
    const html = '<head><link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml"></head>';
    expect(discoverFeedUrl(html, "https://blog.example/post")).toBe("https://blog.example/feed.xml");
  });
  it("falls back to a YouTube canonical channel id", () => {
    const html = '<link rel="canonical" href="https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA">';
    expect(discoverFeedUrl(html, "https://www.youtube.com/@veritasium"))
      .toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA");
  });
  it("returns undefined when the page has neither", () => {
    expect(discoverFeedUrl("<html></html>", "https://x.example")).toBeUndefined();
  });
});

it("watchDigest is one line (+ link) per item, no model", () => {
  expect(watchDigest([{ id: "1", text: "Video", link: "https://v" }, { id: "2", text: "PR 2" }]))
    .toBe("New: Video\nhttps://v\n\nNew: PR 2");
});

describe("routine validation with watch", () => {
  const base = { name: "w", enabled: true, sinks: {} };
  it("requires cron XOR watch", () => {
    expect(describeRoutineError({ ...base, steps: [] })).toMatch(/cron/);
    expect(describeRoutineError({ ...base, cron: "0 8 * * *", watch: { kind: "feed", url: "https://f" }, steps: [] })).toMatch(/not both/);
  });
  it("allows steps: [] only with a watch (notify-only)", () => {
    expect(describeRoutineError({ ...base, watch: { kind: "feed", url: "https://f" }, steps: [] })).toBeNull();
    expect(describeRoutineError({ ...base, cron: "0 8 * * *", steps: [] })).toMatch(/at least one step/);
  });
  it("needs todoDriven when a watch has steps, and validates the interval + source", () => {
    const step = [{ kind: "chat", instruction: "x" }];
    expect(describeRoutineError({ ...base, watch: { kind: "command", command: "c" }, steps: step })).toMatch(/todo-driven/);
    expect(describeRoutineError({ ...base, watch: { kind: "command", command: "c" }, steps: step, todoDriven: true })).toBeNull();
    expect(describeRoutineError({ ...base, watch: { kind: "command", command: "c", everyMinutes: 0 }, steps: [] })).toMatch(/at least 1/);
    expect(describeRoutineError({ ...base, watch: { kind: "command", command: " " }, steps: [] })).toMatch(/command/);
    expect(describeRoutineError({ ...base, watch: { kind: "feed", url: "ftp://x" }, steps: [] })).toMatch(/http/);
  });
});

describe("watch seen-set", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bean-watch-"));
    file = join(dir, "bean.db");
  });
  afterEach(async () => {
    closeDb(file);
    await rm(dir, { recursive: true, force: true });
  });

  it("seed-on-empty still counts as seeded, so the first real item fires", () => {
    expect(isWatchSeeded(file, "r", "command:x")).toBe(false);
    seedWatch(file, "r", "command:x", []);
    expect(isWatchSeeded(file, "r", "command:x")).toBe(true);
    expect(markNewItems(file, "r", ["a"])).toEqual(["a"]);
    expect(markNewItems(file, "r", ["a", "b"])).toEqual(["b"]);
  });

  it("re-seeds when the source changes", () => {
    seedWatch(file, "r", "command:x", ["a"]);
    expect(isWatchSeeded(file, "r", "command:y")).toBe(false);
    expect(countSeen(file, "r")).toBe(0);
  });

  it("caps at max(500, 2 × poll size), keeping ids still in the source", () => {
    seedWatch(file, "r", "s", []);
    const old = Array.from({ length: WATCH_SEEN_CAP }, (_, i) => `old-${i}`);
    let t = 0;
    const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    markNewItems(file, "r", ["keep", ...old], tick);
    markNewItems(file, "r", ["keep", "n1", "n2"], tick);
    expect(countSeen(file, "r")).toBe(WATCH_SEEN_CAP);
    expect(markNewItems(file, "r", ["keep"], tick)).toEqual([]); // still seen, never evicted
  });

  it("clearWatch drops the set and the seed marker (routine delete)", () => {
    seedWatch(file, "r", "s", ["a"]);
    clearWatch(file, "r");
    expect(isWatchSeeded(file, "r", "s")).toBe(false);
    expect(countSeen(file, "r")).toBe(0);
  });
});

it("watchSourceKey changes with the url/command, not the interval", () => {
  expect(watchSourceKey({ kind: "feed", url: "https://a", everyMinutes: 5 })).toBe(watchSourceKey({ kind: "feed", url: "https://a" }));
  expect(watchSourceKey({ kind: "command", command: "a" })).not.toBe(watchSourceKey({ kind: "command", command: "b" }));
});

it("loadRoutineStates keeps lastPoll / pollError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-state-"));
  const file = join(dir, ".state.json");
  await saveRoutineStates(file, { w: { history: [], lastPoll: "2026-09-28T10:00:00.000Z", pollError: "exit 4" } });
  expect((await loadRoutineStates(file)).w).toMatchObject({ lastPoll: "2026-09-28T10:00:00.000Z", pollError: "exit 4" });
  await rm(dir, { recursive: true, force: true });
});

// Type-level: cron is optional now; a watch routine has none.
const _watchRoutine: Routine = { name: "w", enabled: true, watch: { kind: "feed", url: "https://f" }, steps: [], sinks: {} };
void _watchRoutine;
