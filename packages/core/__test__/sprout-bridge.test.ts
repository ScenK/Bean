import { describe, expect, it, vi } from "vitest";
import {
  answerRoutineTrigger, parentSproutTrigger, parseRoutineTrigger, parseRoutineTriggerResult,
  type ParentPort, type RoutineTrigger,
} from "../src/chatops/sprout-bridge.js";
import type { Routine } from "../src/routine-store.js";
import type { TriggerResult } from "../src/routine-scheduler.js";

const steps = [{ kind: "chat" as const, instruction: "x" }];
const schedule: Routine = { name: "digest", enabled: true, cron: "30 6 * * *", steps, sinks: {} };
const watch: Routine = { name: "feed", enabled: true, watch: { kind: "command", command: "x", everyMinutes: 5 }, todoDriven: true, steps, sinks: {} };

describe("wire parsers", () => {
  it("rebuild a trigger from known fields and drop malformed ones", () => {
    expect(parseRoutineTrigger({ type: "routine-trigger", requestId: "q", name: "digest", action: "run", origin: { channel: "c", x: 1 }, text: "hi" }))
      .toEqual({ type: "routine-trigger", requestId: "q", name: "digest", action: "run", origin: { channel: "c" } });
    expect(parseRoutineTrigger({ type: "routine-trigger", requestId: "q", name: "digest", action: "check", origin: {} }))
      .toEqual({ type: "routine-trigger", requestId: "q", name: "digest", action: "check", origin: {} });
    for (const bad of [
      null, "junk", { type: "routine-trigger", requestId: "q", name: "digest", action: "stop", origin: {} },
      { type: "routine-trigger", requestId: "", name: "digest", action: "run", origin: {} },
      { type: "routine-trigger", requestId: "q", name: "x".repeat(201), action: "run", origin: {} },
      { type: "routine-trigger", requestId: "q", name: "digest", action: "run", origin: { channel: 5 } },
      { type: "routine-trigger", requestId: "q", name: "digest", action: "run" },
    ]) expect(parseRoutineTrigger(bad)).toBeUndefined();
  });

  it("accept only known result shapes and refusal codes", () => {
    expect(parseRoutineTriggerResult({ type: "routine-trigger-result", requestId: "q", status: "started", done: 1 }))
      .toEqual({ type: "routine-trigger-result", requestId: "q", status: "started" });
    expect(parseRoutineTriggerResult({ type: "routine-trigger-result", requestId: "q", status: "refused", reason: "busy" }))
      .toEqual({ type: "routine-trigger-result", requestId: "q", status: "refused", reason: "busy" });
    expect(parseRoutineTriggerResult({ type: "routine-trigger-result", requestId: "q", status: "checked", newItems: 2, error: "timeout" }))
      .toEqual({ type: "routine-trigger-result", requestId: "q", status: "checked", newItems: 2, error: "timeout" });
    for (const bad of [
      { type: "routine-trigger-result", requestId: "q", status: "refused", reason: "free text" },
      { type: "routine-trigger-result", requestId: "q", status: "checked", newItems: -1 },
      { type: "routine-trigger-result", requestId: "q", status: "checked", newItems: 1.5 },
      { type: "routine-trigger-result", requestId: "q", status: "checked", newItems: 1, error: "e".repeat(501) },
      { type: "routine-trigger-result", requestId: "q", status: "done" },
      { type: "routine-trigger-result", status: "started" },
    ]) expect(parseRoutineTriggerResult(bad)).toBeUndefined();
  });
});

describe("answerRoutineTrigger (app side)", () => {
  const req = (name: string, action: "run" | "check" = "run"): RoutineTrigger =>
    ({ type: "routine-trigger", requestId: "q", name, action, origin: { channel: "c1" } });
  const deps = (routines: Routine[], facts = { pending: 0, seeded: true }, result: TriggerResult = { status: "started", done: new Promise(() => {}) }) => {
    const trigger = vi.fn(async () => result);
    return { trigger, d: { load: async () => routines, facts: async () => facts, trigger } };
  };

  it("re-resolves the name: a renamed or deleted sprout is refused without triggering", async () => {
    const { trigger, d } = deps([{ ...schedule, name: "digest-v2" }]);
    expect(await answerRoutineTrigger(req("digest"), d)).toEqual({ status: "refused", reason: "missing" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("starts the frozen action with the request's origin", async () => {
    const { trigger, d } = deps([schedule]);
    expect(await answerRoutineTrigger(req("digest"), d)).toEqual({ status: "started" });
    expect(trigger).toHaveBeenCalledWith("digest", "run", { channel: "c1" });
  });

  it("refuses a sprout whose plan changed since the card", async () => {
    // Card said run (queue had items); the queue drained, so it would now be a check.
    const changed = deps([watch], { pending: 0, seeded: true });
    expect(await answerRoutineTrigger(req("feed", "run"), changed.d)).toEqual({ status: "refused", reason: "changed" });
    const off = deps([{ ...watch, enabled: false }]);
    expect(await answerRoutineTrigger(req("feed", "check"), off.d)).toEqual({ status: "refused", reason: "off" });
    const empty = deps([{ ...schedule, todoDriven: true }]);
    expect(await answerRoutineTrigger(req("digest"), empty.d)).toEqual({ status: "refused", reason: "empty" });
    for (const x of [changed, off, empty]) expect(x.trigger).not.toHaveBeenCalled();
  });

  it("maps a check result and a scheduler refusal", async () => {
    const checked = deps([watch], undefined, { status: "checked", result: { newItems: 3 } });
    expect(await answerRoutineTrigger(req("feed", "check"), checked.d)).toEqual({ status: "checked", newItems: 3 });
    const busy = deps([schedule], undefined, { status: "refused", reason: "already running" });
    expect(await answerRoutineTrigger(req("digest"), busy.d)).toEqual({ status: "refused", reason: "busy" });
  });
});

describe("parentSproutTrigger (bot side)", () => {
  function fakePort(connected = true) {
    const sent: RoutineTrigger[] = [];
    let onMessage: (raw: unknown) => void = () => {};
    let onDisconnect: () => void = () => {};
    const port: ParentPort = {
      connected: () => connected,
      send: (m) => { sent.push(m); },
      onMessage: (cb) => { onMessage = cb; },
      onDisconnect: (cb) => { onDisconnect = cb; },
    };
    let n = 0;
    const trigger = parentSproutTrigger(port, 1_000, () => `r${++n}`);
    return { sent, trigger, reply: (m: unknown) => onMessage(m), disconnect: () => onDisconnect() };
  }

  it("settles only its own pending request; strangers and malformed replies are ignored", async () => {
    const p = fakePort();
    const done = p.trigger("digest", "run", { channel: "c1" });
    expect(p.sent).toEqual([{ type: "routine-trigger", requestId: "r1", name: "digest", action: "run", origin: { channel: "c1" } }]);
    p.reply({ type: "routine-trigger-result", requestId: "nobody", status: "started" });
    p.reply({ type: "routine-trigger-result", requestId: "r1", status: "refused", reason: "made-up" });
    p.reply({ type: "routine-trigger-result", requestId: "r1", status: "refused", reason: "missing" });
    p.reply({ type: "routine-trigger-result", requestId: "r1", status: "started" }); // late duplicate: no-op
    await expect(done).resolves.toEqual({ status: "refused", reason: `there's no sprout named "digest" anymore — it was renamed or deleted` });
  });

  it("maps started and checked answers", async () => {
    const p = fakePort();
    const run = p.trigger("digest", "run", {});
    const check = p.trigger("feed", "check", {});
    p.reply({ type: "routine-trigger-result", requestId: "r2", status: "checked", newItems: 2 });
    p.reply({ type: "routine-trigger-result", requestId: "r1", status: "started" });
    await expect(run).resolves.toEqual({ status: "started" });
    await expect(check).resolves.toEqual({ status: "checked", result: { newItems: 2 } });
  });

  it("app gone, never connected, or a failed send → unreachable; no resend", async () => {
    const p = fakePort();
    const done = p.trigger("digest", "run", {});
    p.disconnect();
    await expect(done).resolves.toEqual({ status: "refused", reason: "Bean's desktop app isn't reachable" });
    expect(p.sent).toHaveLength(1);
    await expect(fakePort(false).trigger("digest", "run", {})).resolves.toEqual({ status: "refused", reason: "Bean's desktop app isn't reachable" });
    const failing = parentSproutTrigger({
      connected: () => true, send: (_m, cb) => cb(new Error("closed")), onMessage: () => {}, onDisconnect: () => {},
    });
    await expect(failing("digest", "run", {})).resolves.toMatchObject({ status: "refused", reason: "Bean's desktop app isn't reachable" });
  });

  it("times out when the app never answers", async () => {
    vi.useFakeTimers();
    try {
      const p = fakePort();
      const done = p.trigger("digest", "run", {});
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(done).resolves.toEqual({ status: "refused", reason: "Bean's desktop app didn't answer" });
    } finally {
      vi.useRealTimers();
    }
  });
});
