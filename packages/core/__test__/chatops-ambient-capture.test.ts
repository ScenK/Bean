import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { makeChatter } from "../src/chatops/chatter.js";
import { CAPTURE_DAILY_CALLS, MEMORY_NOTICE, makeAmbientCapture, type AmbientLine } from "../src/chatops/ambient-capture.js";
import type { Role } from "../src/chatops/roles.js";
import type { ConverseDeps } from "../src/converse.js";
import type { Memory } from "../src/memory/memory.js";

const ROLES: Record<string, Role> = { u1: "owner", mia: "member", gus: "guest" };
type Call = { name: string; args: { text: string; quote: string } };

function harness(calls: (prompt: string) => Call[] = () => []) {
  const chatter = makeChatter({ dbPath: join(mkdtempSync(join(tmpdir(), "bean-capture-")), "bean.db"), surface: "discord" });
  let clock = 1_800_000_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const saved: Memory[] = [];
  let auto = true;
  let autoFn: (() => Promise<boolean>) | undefined;
  const prompts: string[] = [];
  let during: (() => void) | undefined;
  const chat = vi.fn<ConverseDeps["chat"]>(async ({ messages }) => {
    const p = String(messages.at(-1)?.content ?? "");
    prompts.push(p);
    during?.();
    return { content: "", toolCalls: calls(p) };
  });
  const capture = makeAmbientCapture({
    chatter, chat, model: "m", roleOf: (s) => ROLES[s.fromId] ?? "guest",
    loadMemories: async () => [...saved], appendMemories: async (m) => { saved.push(...m); },
    autoMemoryEnabled: async () => (autoFn ? autoFn() : auto),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return () => { t.dead = true; }; },
  });
  const posts: string[] = [];
  const reacted: string[] = [];
  const fx = { post: async (t: string) => { posts.push(t); } };
  const say = (fromId: string, text: string, extra: Partial<AmbientLine> = {}, conv = "c"): void =>
    capture.onLine(conv, "s", { fromId, name: fromId === "mia" ? "Mia" : fromId, text, at: clock, react: async () => { reacted.push(text); }, ...extra }, fx);
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    for (const t of timers.filter((x) => !x.dead && x.at <= clock)) { t.dead = true; t.fn(); }
    await settle();
  };
  return {
    chatter, chat, capture, saved, posts, reacted, prompts, say, advance, settle,
    setAuto: (v: boolean) => { auto = v; },
    setAutoFn: (f: (() => Promise<boolean>) | undefined) => { autoFn = f; }, onCall: (f: () => void) => { during = f; },
  };
}

const deploy = (): Call[] => [{ name: "remember", args: { text: "Deploys on Tuesdays", quote: "we deploy on Tuesdays" } }];

test("a member's un-addressed fact saves one shared Name:-prefixed row after the lull, with 🧠 and a one-time notice", async () => {
  const h = harness(deploy);
  h.say("mia", "fyi we deploy on Tuesdays");
  await h.advance(29_000);
  expect(h.chat).not.toHaveBeenCalled();
  await h.advance(1_000);
  expect(h.saved).toMatchObject([{ text: "Mia: Deploys on Tuesdays" }]);
  expect(h.saved[0]!.subjectId).toBeUndefined();
  expect(h.reacted).toEqual(["fyi we deploy on Tuesdays"]);
  expect(h.posts).toEqual([MEMORY_NOTICE]);
  // A second save in the channel: no second notice (persisted, so a new engine wouldn't either).
  h.saved.length = 0;
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.saved).toHaveLength(1);
  expect(h.posts).toEqual([MEMORY_NOTICE]);
  expect(h.chatter.claimMemoryNotice("s")).toBe(false);
});

test("the owner's fact is unprefixed; a steady stream is forced at 2 minutes; an addressed turn flushes", async () => {
  const h = harness(deploy);
  for (let i = 0; i < 5; i++) { h.say("u1", i === 0 ? "we deploy on Tuesdays" : `ok ${i}`); await h.advance(25_000); }
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.saved.map((m) => m.text)).toEqual(["Deploys on Tuesdays"]);
  h.say("mia", "hello", {}, "c2");
  h.capture.flush("c2");
  await h.settle();
  expect(h.chat).toHaveBeenCalledTimes(2);
});

test("guest-only batches cost no model call; guest, bot and quoted lines are never citable", async () => {
  const h = harness(deploy);
  h.say("gus", "we deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.chat).not.toHaveBeenCalled();
  h.say("gus", "we deploy on Tuesdays");
  h.say("mia", "> we deploy on Tuesdays\nreally?");
  h.say("mia", "we deploy on Tuesdays", { bot: true });
  h.say("u1", "look:\n>>> Gus said:\nwe deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.prompts[0]).toContain("gus (not citable): we deploy on Tuesdays");
  expect(h.prompts[0]).toContain("Mia (citable): really?");
  expect(h.prompts[0]).toContain("u1 (not citable): we deploy on Tuesdays");
  expect(h.saved).toEqual([]);
});

test("a quote spanning two speakers, or matching two eligible lines, is rejected", async () => {
  const h = harness(() => [{ name: "remember", args: { text: "Deploys on Tuesdays at noon", quote: "we deploy on Tuesdays at noon" } }]);
  h.say("mia", "we deploy on Tuesdays");
  h.say("u1", "at noon");
  await h.advance(30_000);
  expect(h.saved).toEqual([]);
  const twice = harness(deploy);
  twice.say("mia", "we deploy on Tuesdays");
  twice.say("u1", "yes we deploy on Tuesdays");
  await twice.advance(30_000);
  expect(twice.saved).toEqual([]);
});

test("memory off stops capture — before the call and for a batch already in flight; autoMemory off too", async () => {
  const h = harness(deploy);
  h.say("mia", "we deploy on Tuesdays");
  h.chatter.setMemoryOn("s", false);
  await h.advance(30_000);
  expect(h.chat).not.toHaveBeenCalled();
  h.chatter.setMemoryOn("s", true);
  h.onCall(() => h.chatter.setMemoryOn("s", false));
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.saved).toEqual([]);
  // memory off lands while the post-call autoMemory read is pending.
  let reads = 0;
  h.chatter.setMemoryOn("s", true);
  h.onCall(() => {});
  h.setAutoFn(async () => { if (++reads === 2) h.chatter.setMemoryOn("s", false); return true; });
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.chat).toHaveBeenCalledTimes(2);
  expect(h.saved).toEqual([]);
  h.setAutoFn(undefined);
  h.chatter.setMemoryOn("s", true);
  h.setAuto(false);
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(30_000);
  expect(h.chat).toHaveBeenCalledTimes(2);
  expect(h.saved).toEqual([]);
});

test("the daily call cap holds", async () => {
  const h = harness();
  for (let i = 0; i < CAPTURE_DAILY_CALLS + 3; i++) {
    h.say("mia", `note ${i}`);
    await h.advance(30_000);
  }
  expect(h.chat).toHaveBeenCalledTimes(CAPTURE_DAILY_CALLS);
});
