import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPulsePlan, dbFile, getMindItem, listPendingHomePosts, loadPulseState, updatePulseState,
  type OutboxMessage, type Proactivity, type PulseResult,
} from "@bean/core";
import { deliverPulsePost, runPulseIfDue, type PulseLoopDeps } from "../src/pulse.js";
import { buildSeedHandlers } from "../src/handlers.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-pulse-"));
  file = dbFile(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOON = new Date(2026, 10, 27, 12);

function setup(result: PulseResult = { level: "medium", post: "How did the dentist go?" }, over: Partial<PulseLoopDeps> = {}) {
  const sent: Omit<OutboxMessage, "id" | "createdAt">[] = [];
  const h = { dial: "medium" as Proactivity, lease: true, now: NOON, passes: 0, bumps: 0, during: (): void => {} };
  const deps: PulseLoopDeps = {
    dbFile: file, name: () => "Pip", onHomePost: () => { h.bumps++; },
    homeDms: () => ({ discord: true, teams: true }), reach: async () => ({ discord: 1, teams: 0 }),
    enqueue: async (m) => { sent.push(m); return "id"; },
    canRun: () => h.lease, proactivity: async () => h.dial, now: () => h.now,
    pulse: async () => {
      h.passes++;
      updatePulseState(file, (s) => ({ ...s, lastPulseAt: h.now.toISOString() }));
      h.during();
      return result;
    },
    ...over,
  };
  return { h, sent, deps, check: () => runPulseIfDue(deps, memo, new AbortController().signal) };
}
let memo = { lastTry: 0 };
beforeEach(() => { memo = { lastTry: 0 }; });

describe("deliverPulsePost (#1157)", () => {
  test("a pulse Home post plus a prefix-free DM copy to each reachable owner DM, keyed like the drain", async () => {
    const { deps, sent, h } = setup();
    const id = await deliverPulsePost(deps, "How did the dentist go?");
    expect(listPendingHomePosts(file)).toEqual([expect.objectContaining({ id, sprout: "Pip", body: "How did the dentist go?", kind: "pulse" })]);
    expect(h.bumps).toBe(1);
    expect(sent).toEqual([{ transport: "discord", body: "How did the dentist go?", context: true, mainTurnKey: `post:${id}`, kind: "pulse" }]);
  });
});

describe("runPulseIfDue (#1157)", () => {
  test("posts the check-in once per cadence and counts it as a nudge", async () => {
    const { h, sent, check } = setup();
    await check();
    expect(h.passes).toBe(1);
    expect(listPendingHomePosts(file)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(loadPulseState(file)).toMatchObject({ unanswered: 1, introduced: true });
    h.now = new Date(NOON.getTime() + 60 * 60_000); // medium = every 3h
    expect(await check()).toBe("not-due");
    h.now = new Date(NOON.getTime() + 181 * 60_000);
    await check();
    expect(h.passes).toBe(2);
  });

  test("a failing pass waits out the cadence too", async () => {
    const { h, check } = setup(undefined, { pulse: async () => { h.passes++; throw new Error("no key"); } });
    await expect(check()).rejects.toThrow("no key");
    expect(await check()).toBe("not-due");
    expect(h.passes).toBe(1);
  });

  test("nothing runs without the lease, with the dial off, or in quiet hours", async () => {
    const { h, check } = setup();
    h.lease = false;
    expect(await check()).toBe("standby");
    h.lease = true;
    h.dial = "off";
    expect(await check()).toBe("off");
    h.dial = "medium";
    h.now = new Date(2026, 10, 27, 23);
    expect(await check()).toBe("quiet-hours");
    expect(h.passes).toBe(0);
  });

  test("re-checked after the model call: a lost lease, Off, or 22:00 posts nothing", async () => {
    for (const flip of [(h: { lease: boolean }) => { h.lease = false; }, (h: { dial: Proactivity }) => { h.dial = "off"; },
      (h: { now: Date }) => { h.now = new Date(2026, 10, 27, 22, 1); }] as ((h: object) => void)[]) {
      const { h, sent, check } = setup();
      h.during = () => flip(h);
      memo = { lastTry: 0 };
      await check();
      expect(sent).toEqual([]);
      expect(loadPulseState(file).unanswered).toBe(0);
      expect(listPendingHomePosts(file).filter((p) => p.kind === "pulse")).toHaveLength(0);
    }
  });

  test("the step-down notice is posted but never counted; a dial change mid-pass drops it", async () => {
    const lowered: PulseResult = { level: "low", lowered: { from: "medium", to: "low" }, announcement: "I'll keep quieter." };
    const a = setup(lowered);
    await a.check();
    expect(listPendingHomePosts(file).map((p) => p.body)).toEqual(["I'll keep quieter."]);
    expect(loadPulseState(file).unanswered).toBe(0);

    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "bean-pulse-"));
    file = dbFile(dir);
    memo = { lastTry: 0 };
    const b = setup(lowered, { dbFile: file });
    b.h.during = () => { b.h.dial = "high"; };
    await b.check();
    expect(listPendingHomePosts(file)).toEqual([]);
  });
});

describe("seed handlers (#1157)", () => {
  const seed = (): string => {
    const out = applyPulsePlan(file, { upserts: [{ topicKey: "dentist", text: "Dentist follow-up" }], resolve: [] }, NOON);
    return out.added[0]!;
  };

  test("resolve is version-checked, resets the backoff streak, and Undo brings it back", () => {
    const h = buildSeedHandlers({ dbFile: file, now: () => NOON });
    const id = seed();
    updatePulseState(file, (s) => ({ ...s, unanswered: 2 }));
    expect(() => h.resolve(id, "done", 99)).toThrow("changed");
    const done = h.resolve(id, "done", 1);
    expect(done).toMatchObject({ status: "done", version: 2 });
    expect(loadPulseState(file).unanswered).toBe(0);
    expect(h.resolve(id, "done", 2)).toBeUndefined(); // already closed
    expect(() => h.undo(id, 1)).toThrow("changed");
    expect(h.undo(id, 2)).toMatchObject({ status: "active", version: 3 });
    expect(h.list().map((s) => s.id)).toEqual([id]);
  });

  test("a dismiss keeps its reason; malformed requests throw", () => {
    const h = buildSeedHandlers({ dbFile: file, now: () => NOON });
    const id = seed();
    expect(() => h.resolve(id, "done", 1, "wrong")).toThrow("malformed");
    expect(() => h.resolve(id, "deleted", 1)).toThrow("malformed");
    expect(() => h.resolve(id, "dismissed", "1")).toThrow("malformed");
    expect(() => h.resolve(id, "dismissed", 1, "meh")).toThrow("malformed");
    expect(h.resolve(id, "dismissed", 1, "wrong")).toMatchObject({ status: "dismissed", dismissReason: "wrong" });
    expect(getMindItem(file, id)?.status).toBe("dismissed");
  });
});
