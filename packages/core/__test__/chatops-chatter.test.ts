import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeChatter, parseChatterCommand } from "../src/chatops/chatter.js";

const db = (): string => join(mkdtempSync(join(tmpdir(), "bean-chatter-")), "bean.db");

test("parser: chatty on/off/status, unmute, and whole-message mutes with clamped durations", () => {
  expect(parseChatterCommand("chatty on")).toEqual({ kind: "chatty", arg: "on" });
  expect(parseChatterCommand("/Chatty OFF")).toEqual({ kind: "chatty", arg: "off" });
  expect(parseChatterCommand("chatty")).toEqual({ kind: "chatty", arg: "status" });
  expect(parseChatterCommand("unmute!")).toEqual({ kind: "unmute" });
  expect(parseChatterCommand("memory off")).toEqual({ kind: "memory", arg: "off" });
  expect(parseChatterCommand("/Memory status.")).toEqual({ kind: "memory", arg: "status" });
  expect(parseChatterCommand("memory")).toBeUndefined();
  expect(parseChatterCommand("quiet 5m")).toEqual({ kind: "mute", minutes: 5 });
  expect(parseChatterCommand("hush 30m")).toEqual({ kind: "mute", minutes: 30 });
  expect(parseChatterCommand("be quiet")).toEqual({ kind: "mute", minutes: 30 });
  expect(parseChatterCommand("Stay quiet for 2 hours.")).toEqual({ kind: "mute", minutes: 120 });
  expect(parseChatterCommand("mute 0m")).toEqual({ kind: "mute", minutes: 1 });
  expect(parseChatterCommand("mute 48h")).toEqual({ kind: "mute", minutes: 1440 });
  for (const t of ["be quiet about X and do Y", "quiet please", "mute the mac 5m", "chatty maybe", "hush 5 days", `mute${"!".repeat(30_000)}x`]) {
    expect(parseChatterCommand(t), t).toBeUndefined();
  }
});

test("state: missing row is off; on clears a mute; it survives a reopen", () => {
  const dbPath = db();
  const a = makeChatter({ dbPath, surface: "discord" });
  expect(a.get("s1")).toEqual({ enabled: false });
  a.setEnabled("s1", true);
  a.setMutedUntil("s1", 123);
  expect(makeChatter({ dbPath, surface: "discord" }).get("s1")).toEqual({ enabled: true, mutedUntil: 123 });
  expect(makeChatter({ dbPath, surface: "teams" }).get("s1")).toEqual({ enabled: false });
  a.setEnabled("s1", true);
  expect(a.get("s1")).toEqual({ enabled: true });
  a.setEnabled("s1", false);
  expect(a.get("s1")).toEqual({ enabled: false });
});

// --- chime-in engine (#445) ---

import { vi } from "vitest";
import { CHIME_COOLDOWN_MS, makeChimeIn, trimChimeIn, type ChimeInDeps } from "../src/chatops/chatter.js";
import { ConversationStore } from "../src/chatops/conversation.js";
import type { Memory } from "../src/memory/memory.js";

function harness(reply: () => Promise<{ content: string; toolCalls: { name: string; args: unknown }[] }> | { content: string; toolCalls: [] } = () => ({ content: "Try `pnpm why`. It lists the path.", toolCalls: [] })) {
  const dbPath = db();
  const chatter = makeChatter({ dbPath, surface: "discord" });
  chatter.setEnabled("s", true);
  const conversations = new ConversationStore(dbPath);
  let clock = 1_800_000_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const chat = vi.fn(async (_req: Parameters<ChimeInDeps["chat"]>[0]) => reply());
  const memories: Memory[] = [
    { id: "1", text: "household uses pnpm", createdAt: "2026-01-01T00:00:00Z", projectPath: "/Users/x/secret-proj" },
    { id: "2", text: "PRIVATE thing", createdAt: "2026-01-01T00:00:00Z", subjectId: "u1" },
  ];
  const loadMemories = vi.fn(async (_s: null) => memories);
  let live = false;
  const engine = makeChimeIn({
    chatter, chat, model: "m", conversations, loadMemories,
    loadPersona: async () => ({ name: "Bean", tags: ["friendly"] }) as never,
    liveSession: () => live,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return () => { t.dead = true; }; },
  });
  const chatterMsgs: { fromName: string; text: string; at: number }[] = [];
  const posts: string[] = [];
  const fx = { fetchRecent: async (since: number) => chatterMsgs.filter((m) => m.at >= since), post: async (t: string) => { posts.push(t); } };
  const say = (text: string): void => { chatterMsgs.push({ fromName: "Ann", text, at: clock }); engine.onAmbient("c", "s", fx); };
  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    for (const t of timers.filter((x) => !x.dead && x.at <= clock)) { t.dead = true; t.fn(); }
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return { chatter, conversations, chat, loadMemories, engine, posts, say, advance, setLive: (v: boolean) => { live = v; }, tick: (ms: number) => { clock += ms; } };
}

test("a burst gets one call after the lull; under 2 new messages gets none", async () => {
  const h = harness();
  h.say("one");
  await h.advance(31_000);
  expect(h.chat).not.toHaveBeenCalled();
  for (let i = 0; i < 9; i++) { h.say(`m${i}`); await h.advance(5_000); }
  await h.advance(31_000);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.posts).toEqual(["Try `pnpm why`. It lists the path."]);
  const req = h.chat.mock.calls[0]![0];
  expect(req.tools).toEqual([]);
  expect(req.webSearch).toBe(false);
  const text = JSON.stringify(req.messages);
  expect(h.loadMemories).toHaveBeenCalledWith(null);
  expect(text).toContain("household uses pnpm");
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("secret-proj");
  // Recall is its own user-role message (never system), before the ambient block.
  expect(req.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
  expect(req.messages[0]!.content).not.toContain("household uses pnpm");
  expect(req.messages[1]!.content).toContain("household uses pnpm");
  expect(req.messages[2]!.content).not.toContain("household uses pnpm");
  // Spoke: window + reply persisted (recall never is), cutoff advanced.
  expect(h.conversations.history("c").map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(h.conversations.history("c"))).not.toContain("household uses pnpm");
  expect(h.conversations.ambientCutoff("c")).toBeGreaterThan(0);
});

test("a steady stream is forced at 2 minutes", async () => {
  const h = harness();
  for (let i = 0; i < 14; i++) { h.say(`m${i}`); await h.advance(10_000); }
  expect(h.chat).toHaveBeenCalledTimes(1);
});

test("<silent>, empty and tool calls leave history and the cutoff alone and post nothing", async () => {
  for (const r of [{ content: "<silent>", toolCalls: [] }, { content: "  ", toolCalls: [] }, { content: "Sure.", toolCalls: [{ name: "x", args: {} }] }]) {
    const h = harness(() => r as never);
    h.say("a"); h.say("b");
    await h.advance(31_000);
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.posts).toEqual([]);
    expect(h.conversations.history("c")).toEqual([]);
    expect(h.conversations.ambientCutoff("c")).toBe(0);
  }
});

test("a mute, new message, addressed turn or live session during the call drops the reply", async () => {
  const cases: ((h: ReturnType<typeof harness>) => void)[] = [
    (h) => h.chatter.setMutedUntil("s", Date.now() * 2),
    (h) => h.say("newer"),
    (h) => h.engine.cancel("c"),
    (h) => h.setLive(true),
  ];
  for (const during of cases) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness(async () => { await gate; return { content: "Hi there.", toolCalls: [] }; });
    h.say("a"); h.say("b");
    await h.advance(31_000);
    during(h);
    release();
    await h.advance(0);
    expect(h.posts).toEqual([]);
    expect(h.conversations.history("c")).toEqual([]);
  }
});

test("claim: cooldown, daily caps and one attempt in flight hold", () => {
  const h = harness();
  const t = 1_800_000_000_000;
  expect(h.chatter.claim("s", t)).toBe(true);
  expect(h.chatter.claim("s", t)).toBe(false); // in flight
  h.chatter.release("s", true, t);
  expect(h.chatter.claim("s", t + CHIME_COOLDOWN_MS - 1)).toBe(false); // cooldown
  expect(h.chatter.claim("s", t + CHIME_COOLDOWN_MS)).toBe(true);
  h.chatter.release("s", false, t + CHIME_COOLDOWN_MS);
  expect(h.chatter.claim("other", t)).toBe(false); // not enabled
  // Attempts cap: 2 used, 98 more, then refused for the day.
  let n = 0;
  while (h.chatter.claim("s", t + CHIME_COOLDOWN_MS)) { h.chatter.release("s", false, t + CHIME_COOLDOWN_MS); n++; }
  expect(n).toBe(98);
  expect(h.chatter.claim("s", t + 2 * 86_400_000)).toBe(true); // a new day resets
  // Expired claim (crash) is reclaimable.
  expect(h.chatter.claim("s", t + 2 * 86_400_000 + 6 * 60_000)).toBe(true);
});

test("spoken cap: 24 chime-ins a day", () => {
  const h = harness();
  let t = new Date(2027, 0, 5, 1, 0).getTime(); // local 1am: 30 tries at 10-min steps stay in one day
  let n = 0;
  for (let i = 0; i < 30; i++, t += CHIME_COOLDOWN_MS) if (h.chatter.claim("s", t)) { h.chatter.release("s", true, t); n++; }
  expect(n).toBe(24);
});

test("trim stops at the last sentence end within 500 chars, never mid-sentence", () => {
  expect(trimChimeIn("One. Two!")).toBe("One. Two!");
  expect(trimChimeIn("no sentence end")).toBeUndefined();
  expect(trimChimeIn("Pi is 3.14 roughly")).toBeUndefined();
  const long = `${"a".repeat(480)}. ${"b".repeat(100)}.`;
  expect(trimChimeIn(long)).toBe(`${"a".repeat(480)}.`);
});
