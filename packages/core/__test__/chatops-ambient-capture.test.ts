import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { makeChatter } from "../src/chatops/chatter.js";
import { CAPTURE_DAILY_CALLS, EPISODE_FORCE_MS, EPISODE_LULL_MS, MEMORY_NOTICE, makeAmbientCapture, type AmbientLine } from "../src/chatops/ambient-capture.js";
import type { Role } from "../src/chatops/roles.js";
import type { ConverseDeps } from "../src/converse.js";
import type { Memory } from "../src/memory/memory.js";

const ROLES: Record<string, Role> = { u1: "owner", mia: "member", gus: "guest" };
type Call = { name: string; args: { text: string; evidence?: number[]; expires?: string; category?: string; sourceId?: string; sourceTitle?: string } };

function harness(calls: (prompt: string) => Call[] = () => [], surface: "discord" | "teams" = "discord") {
  const chatter = makeChatter({ dbPath: join(mkdtempSync(join(tmpdir(), "bean-capture-")), "bean.db"), surface });
  let clock = 1_800_000_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const saved: Memory[] = [];
  let auto = true;
  let autoFn: (() => Promise<boolean>) | undefined;
  const prompts: string[] = [];
  const scopes: string[] = [];
  let during: (() => void) | undefined;
  const chat = vi.fn<ConverseDeps["chat"]>(async ({ messages }) => {
    const p = String(messages.at(-1)?.content ?? "");
    prompts.push(p);
    during?.();
    return { content: "", toolCalls: calls(p) };
  });
  const capture = makeAmbientCapture({
    chatter, chat, model: "m", roleOf: (s) => ROLES[s.fromId] ?? "guest",
    loadMemories: async (_s, scope) => { scopes.push(scope.source); return [...saved]; }, appendMemories: async (m) => { saved.push(...m); },
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
    chatter, chat, capture, saved, posts, reacted, prompts, scopes, say, advance, settle,
    setAuto: (v: boolean) => { auto = v; },
    setAutoFn: (f: (() => Promise<boolean>) | undefined) => { autoFn = f; }, onCall: (f: () => void) => { during = f; },
  };
}

const LULL = EPISODE_LULL_MS;
// The model offers a category; channel capture is never an owner path, so it's dropped (#648).
const deploy = (): Call[] => [{ name: "remember", args: { text: "Mia's team deploys on Tuesdays", evidence: [1], category: "You" } }];

test("an episode is written once the chat has been quiet for 10 minutes: one shared row in Bean's words, 🧠 on the cited line, a one-time notice", async () => {
  const h = harness(deploy);
  h.say("mia", "fyi we deploy on Tuesdays");
  await h.advance(LULL - 1_000);
  expect(h.chat).not.toHaveBeenCalled();
  await h.advance(1_000);
  expect(h.saved).toMatchObject([{ text: "Mia's team deploys on Tuesdays", evidence: "Mia: fyi we deploy on Tuesdays" }]);
  expect(h.saved[0]!.subjectId).toBeUndefined();
  expect(h.saved[0]!.category).toBeUndefined();
  expect(h.reacted).toEqual(["fyi we deploy on Tuesdays"]);
  expect(h.posts).toEqual([MEMORY_NOTICE]);
  // A second save in the channel: no second notice (persisted, so a new engine wouldn't either).
  h.say("mia", "and we freeze on Fridays");
  await h.advance(LULL);
  expect(h.posts).toEqual([MEMORY_NOTICE]);
  expect(h.chatter.claimMemoryNotice("s")).toBe(false);
});

test("the model sees the whole exchange — every speaker, the owner marked — so an OK is read with what it answers", async () => {
  const h = harness(() => [{
    name: "remember", args: { text: "u1 agreed to go out with Mia on 2027-01-16 at 3pm", evidence: [2, 3], expires: "2027-01-17T08:00:00Z" },
  }]);
  h.say("u1", "busy lately, but I want to get out");
  h.say("mia", "let's go out tomorrow around 3pm");
  h.say("gus", "have fun");
  h.say("u1", "OK");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.prompts[0]).toContain("--- new ---\n[1] u1 (owner): busy lately, but I want to get out\n[2] Mia: let's go out tomorrow around 3pm\n[3] gus: have fun\n[4] u1 (owner): OK");
  expect(h.saved).toMatchObject([{
    text: "u1 agreed to go out with Mia on 2027-01-16 at 3pm", expiresAt: "2027-01-17T08:00:00.000Z",
    evidence: "Mia: let's go out tomorrow around 3pm / gus: have fun",
  }]);
});

test("the already-remembered list is this conversation's, and rides the user message, never the system message", async () => {
  const h = harness(deploy);
  h.say("mia", "fyi we deploy on Tuesdays");
  await h.advance(LULL);
  h.say("mia", "hello everyone");
  await h.advance(LULL);
  expect(h.scopes).toEqual(["discord:s", "discord:s"]);
  const messages = h.chat.mock.calls[1]![0].messages;
  expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(messages[0]!.content).not.toContain("deploys on Tuesdays");
  expect(messages[1]!.content).toMatch(/^Already saved — for de-duplication only, not citable:\n- Mia's team deploys on Tuesdays\n\n/);
  expect(h.saved).toHaveLength(1); // the same text again is a duplicate
});

test("a steady stream is forced at 60 minutes; an addressed turn ends the episode at once", async () => {
  const h = harness(deploy);
  for (let t = 0; t < EPISODE_FORCE_MS; t += 5 * 60_000) { h.say("u1", `line at ${t}`); await h.advance(5 * 60_000); }
  expect(h.chat).toHaveBeenCalledTimes(1);
  h.say("mia", "hello", {}, "c2");
  h.capture.flush("c2");
  await h.settle();
  expect(h.chat).toHaveBeenCalledTimes(2);
});

test("a bots-only batch costs no model call; a bot line is shown marked", async () => {
  const h = harness();
  h.say("ci", "build passed", { bot: true });
  await h.advance(LULL);
  expect(h.chat).not.toHaveBeenCalled();
  h.say("ci", "build failed", { bot: true });
  h.say("gus", "I'll take a look");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.prompts[0]).toContain("[1] ci (bot): build passed\n--- new ---\n[2] ci (bot): build failed\n[3] gus: I'll take a look");
});

test("memory off stops capture — before the call and for a batch already in flight; autoMemory off too", async () => {
  const h = harness(deploy);
  h.say("mia", "we deploy on Tuesdays");
  h.chatter.setMemoryOn("s", false);
  await h.advance(LULL);
  expect(h.chat).not.toHaveBeenCalled();
  h.chatter.setMemoryOn("s", true);
  h.onCall(() => h.chatter.setMemoryOn("s", false));
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.saved).toEqual([]);
  // memory off lands while the post-call autoMemory read is pending.
  let reads = 0;
  h.chatter.setMemoryOn("s", true);
  h.onCall(() => {});
  h.setAutoFn(async () => { if (++reads === 2) h.chatter.setMemoryOn("s", false); return true; });
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(2);
  expect(h.saved).toEqual([]);
  // Lines said while memory was off never become a later episode's context.
  h.setAutoFn(undefined);
  h.chatter.setMemoryOn("s", false);
  h.say("mia", "my door code is on the fridge");
  await h.advance(LULL);
  h.chatter.setMemoryOn("s", true);
  h.say("mia", "anyway, lunch?");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(3);
  expect(h.prompts[2]).not.toContain("door code");
  h.saved.length = 0;
  h.setAuto(false);
  h.say("mia", "we deploy on Tuesdays");
  await h.advance(LULL);
  expect(h.chat).toHaveBeenCalledTimes(3);
  expect(h.saved).toEqual([]);
});

test("the daily call cap holds", async () => {
  const h = harness();
  for (let i = 0; i < CAPTURE_DAILY_CALLS + 3; i++) {
    h.say("mia", `note ${i}`);
    h.capture.flush("c");
    await h.settle();
  }
  expect(h.chat).toHaveBeenCalledTimes(CAPTURE_DAILY_CALLS);
});

test("a capture records its source from the adapter: <surface>:<scopeId> plus the place title, never the model's args", async () => {
  // The model tries to supply its own source; only the adapter's place and the scope count (#649).
  const spoofed = (): Call[] => [{ name: "remember", args: { ...deploy()[0]!.args, sourceId: "teams:evil", sourceTitle: "Spoof" } }];
  const d = harness(spoofed);
  d.say("mia", "we deploy on Tuesdays", { place: { kind: "channel", title: "#eng" } });
  await d.advance(LULL);
  expect(d.saved).toMatchObject([{ sourceId: "discord:s", sourceTitle: "#eng" }]);

  const t = harness(spoofed, "teams");
  t.say("mia", "we deploy on Tuesdays", { place: { kind: "channel", title: ` Weekend\n\tcrew ${"x".repeat(100)}` } });
  await t.advance(LULL);
  expect(t.saved[0]!.sourceId).toBe("teams:s");
  expect(t.saved[0]!.sourceTitle).toBe(`Weekend crew ${"x".repeat(100)}`.slice(0, 80));

  // No place from the adapter: the id still records, with no title.
  const n = harness(deploy);
  n.say("mia", "we deploy on Tuesdays");
  await n.advance(LULL);
  expect(n.saved[0]).toMatchObject({ sourceId: "discord:s" });
  expect(n.saved[0]!.sourceTitle).toBeUndefined();
});

test("an addressed turn can split an exchange: the earlier lines ride along as context above the new marker (#857)", async () => {
  const h = harness();
  h.say("u1", "anyone up for the Friday hike?");
  h.capture.flush("c");
  await h.settle();
  h.say("mia", "I am bringing snacks");
  await h.advance(LULL);
  expect(h.prompts[1]).toContain("[1] u1 (owner): anyone up for the Friday hike?\n--- new ---\n[2] Mia: I am bringing snacks");
  // An hour later the old lines are no longer context.
  await h.advance(60 * 60_000);
  h.say("mia", "I am bringing snacks");
  await h.advance(LULL);
  expect(h.prompts[2]).not.toContain("Friday hike");
});

test("live steering (#861) shares the scope's daily call cap and obeys `memory off` landing mid-call", async () => {
  const h = harness(() => [{ name: "remember", args: { text: "Deploys on Tuesdays", category: "You" } }]);
  const steer = (): Promise<void> => h.capture.steer("s", "Live: deploy", [{ role: "user", content: "we deploy on Tuesdays", source: "typed" }], []);
  h.onCall(() => h.chatter.setMemoryOn("s", false));
  await steer();
  expect(h.chat).toHaveBeenCalledTimes(1);
  expect(h.saved).toEqual([]);
  h.onCall(() => {});
  await steer(); // still off: no call
  expect(h.chat).toHaveBeenCalledTimes(1);
  h.chatter.setMemoryOn("s", true);
  await steer();
  expect(h.saved).toEqual([expect.objectContaining({ text: "Deploys on Tuesdays", sourceId: "discord:s", sourceTitle: "Live: deploy" })]);
  expect(h.saved[0]!.category).toBeUndefined();
  expect(h.posts).toEqual([]); // no one-time notice from a steer
  for (let i = 2; i < CAPTURE_DAILY_CALLS + 3; i++) await steer();
  expect(h.chat).toHaveBeenCalledTimes(CAPTURE_DAILY_CALLS);
});
