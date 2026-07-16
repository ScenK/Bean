import { expect, test, vi } from "vitest";
import { exitWhenOrphaned, type TimerHandle } from "../src/chatops/orphan-guard.js";

function harness(ppids: number[]) {
  let call = 0;
  const exits: number[] = [];
  const logs: string[] = [];
  const timers: (() => void)[] = [];
  const stop = exitWhenOrphaned({
    getPpid: () => ppids[Math.min(call++, ppids.length - 1)]!,
    exit: (code) => { exits.push(code); },
    log: (m) => { logs.push(m); },
    // capture the tick instead of waiting on a real interval
    setIntervalFn: (fn) => { timers.push(fn); return {}; },
    clearIntervalFn: () => {},
  });
  return { exits, logs, tick: () => timers.forEach((f) => f()), stop };
}

test("keeps running while the parent is alive", () => {
  const h = harness([500, 500, 500]);
  h.tick();
  h.tick();
  expect(h.exits).toEqual([]);
});

// The real orphan case: the app dies, launchd reparents the server to pid 1, and it
// otherwise keeps serving webhooks forever with whatever code it booted with.
test("exits once the parent dies and the process is reparented to launchd", () => {
  const h = harness([500, 1]);
  h.tick();
  expect(h.exits).toEqual([0]);
  expect(h.logs.join(" ")).toContain("parent");
});

test("exits when the parent pid changes to any new owner, not just pid 1", () => {
  const h = harness([500, 742]);
  h.tick();
  expect(h.exits).toEqual([0]);
});

test("only exits once even if the tick fires again", () => {
  const h = harness([500, 1, 1]);
  h.tick();
  h.tick();
  expect(h.exits).toEqual([0]);
});

test("stop() cancels the watchdog", () => {
  const cleared: TimerHandle[] = [];
  const handle: TimerHandle = {};
  const stop = exitWhenOrphaned({
    getPpid: () => 500,
    exit: () => {},
    log: () => {},
    setIntervalFn: () => handle,
    clearIntervalFn: (t) => { cleared.push(t); },
  });
  stop();
  expect(cleared).toEqual([handle]);
});

test("defaults are wired to the real process without exiting under a live parent", () => {
  const exits: number[] = [];
  const stop = exitWhenOrphaned({ exit: (c) => { exits.push(c); }, log: () => {} });
  expect(exits).toEqual([]);
  stop();
});

test("the watchdog interval does not hold the event loop open", () => {
  const unref = vi.fn();
  const stop = exitWhenOrphaned({
    getPpid: () => 500,
    exit: () => {},
    log: () => {},
    setIntervalFn: () => ({ unref }),
    clearIntervalFn: () => {},
  });
  expect(unref).toHaveBeenCalled();
  stop();
});
