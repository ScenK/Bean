import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DelegateCallbacks, DelegateRequest } from "../src/index.js";
import { RunRegistry } from "../src/chatops/runs.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const req: DelegateRequest = { cli: "claude", projectPath: "/p", prompt: "do" };
const meta = { instruction: "do the thing", conversationId: "c1" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bean-runs-"));
}

function fakeRun() {
  const calls: { req: DelegateRequest; cb: DelegateCallbacks }[] = [];
  const cancelled: boolean[] = [];
  const fn = (r: DelegateRequest, cb: DelegateCallbacks) => {
    calls.push({ req: r, cb });
    return { cancel: (done?: () => void) => { cancelled.push(true); done?.(); } };
  };
  return { fn, calls, cancelled };
}

function events() {
  return { onTail: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onCancelled: vi.fn() };
}

test("second start on the same project is rejected while the first runs", async () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  const ev = events();
  expect(await reg.start(req, ev, meta)).toBe(true);
  expect(await reg.start(req, ev, meta)).toBe(false);
  calls[0]?.cb.onDone("result");
  expect(ev.onDone).toHaveBeenCalledWith("result");
  expect(await reg.start(req, ev, meta)).toBe(true); // freed after completion
});

test("tail lines are throttled: only the latest line flushes per interval", async () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord", throttleMs: 5000 });
  const ev = events();
  await reg.start(req, ev, meta);
  calls[0]?.cb.onOutput("line 1");
  calls[0]?.cb.onOutput("line 2");
  expect(ev.onTail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(ev.onTail).toHaveBeenCalledTimes(1);
  expect(ev.onTail).toHaveBeenCalledWith("line 2");
  vi.advanceTimersByTime(5000); // no new output → no extra flush
  expect(ev.onTail).toHaveBeenCalledTimes(1);
});

test("error frees the project and reports the message", async () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  const ev = events();
  await reg.start(req, ev, meta);
  calls[0]?.cb.onError(new Error("boom"));
  expect(ev.onError).toHaveBeenCalledWith("boom");
  expect(reg.isRunning("/p")).toBe(false);
});

test("cancelAll cancels every active run and returns the count", async () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  await reg.start(req, events(), meta);
  await reg.start({ ...req, projectPath: "/q" }, events(), meta);
  expect(reg.cancelAll()).toBe(2);
  expect(cancelled).toHaveLength(2);
  expect(reg.cancelAll()).toBe(0);
});

test("a run that settles synchronously (spawn failure) leaves the project free", async () => {
  const reg = new RunRegistry((_r, cb) => {
    cb.onError(new Error("spawn failed"));
    return { cancel: () => {} };
  }, { dir: tmp(), botKind: "discord" });
  const ev = events();
  expect(await reg.start(req, ev, meta)).toBe(true);
  expect(ev.onError).toHaveBeenCalledWith("spawn failed");
  expect(reg.isRunning("/p")).toBe(false);
  expect(await reg.start(req, events(), meta)).toBe(true); // path not stuck busy
});

test("stale callbacks from a cancelled run cannot corrupt a newer run", async () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord", throttleMs: 5000 });
  const evA = events();
  await reg.start(req, evA, meta);
  reg.cancel("/p");
  const evB = events();
  expect(await reg.start(req, evB, meta)).toBe(true);
  // Run A's delegate misbehaves and fires onDone after cancel.
  calls[0]?.cb.onDone("late");
  expect(evA.onDone).not.toHaveBeenCalled();
  expect(reg.isRunning("/p")).toBe(true); // B still registered
  // B's throttle timer must still be alive.
  calls[1]?.cb.onOutput("b line");
  vi.advanceTimersByTime(5000);
  expect(evB.onTail).toHaveBeenCalledWith("b line");
});

test("cancel cancels the underlying handle and fires onCancelled", async () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  const ev = events();
  await reg.start(req, ev, meta);
  expect(reg.cancel("/p")).toBe(true);
  expect(cancelled).toHaveLength(1);
  expect(ev.onCancelled).toHaveBeenCalled();
  expect(reg.isRunning("/p")).toBe(false);
  expect(reg.cancel("/p")).toBe(false);
});

test("cancel does not release the reservation until the handle confirms the child actually stopped", async () => {
  const dir = tmp();
  let confirm: (() => void) | undefined;
  const fn = () => ({ cancel: (done?: () => void) => { confirm = done; } });
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const ev = events();
  await reg.start(req, ev, meta);
  expect(reg.cancel("/p")).toBe(true);
  // SIGTERM sent, but the child hasn't confirmed it stopped yet — the project must still read
  // as busy, or a relaunch/other surface could start a second run on it right now.
  expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
  expect(ev.onCancelled).not.toHaveBeenCalled();
  confirm?.();
  expect(ev.onCancelled).toHaveBeenCalled();
  expect(readdirSync(join(dir, "runs"))).toEqual([]); // released only now
});

test("start reserves the project cross-process (a second RunRegistry sharing the same dir is refused)", async () => {
  const dir = tmp();
  const { fn: fnA } = fakeRun();
  const { fn: fnB } = fakeRun();
  const regA = new RunRegistry(fnA, { dir, botKind: "discord" });
  const regB = new RunRegistry(fnB, { dir, botKind: "teams" });
  expect(await regA.start(req, events(), meta)).toBe(true);
  expect(await regB.start(req, events(), meta)).toBe(false); // same projectPath, different process (simulated)
});

test("interruptAll leaves the reservation in place (doesn't free the project) and leaves an outbox notice per run", async () => {
  const dir = tmp();
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  await reg.start(req, events(), meta);
  const n = reg.interruptAll();
  expect(n).toBe(1);
  expect(cancelled).toHaveLength(1);
  expect(reg.isRunning("/p")).toBe(false); // no longer tracked in this process's memory
  // The reservation is NOT released: this process is exiting with no confirmation the delegate
  // child actually stopped, so releasing blind would let a relaunch double-run the same
  // project. It stays busy (under the reservation's already-live pid) until reclaimed.
  expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
  const outboxFiles = readdirSync(join(dir, "outbox"));
  expect(outboxFiles).toHaveLength(1);
  expect(outboxFiles[0]).toMatch(/^discord-/);
  // A second RunRegistry (simulating a relaunch) sharing the same dir still sees it as busy.
  const { fn: fn2 } = fakeRun();
  const reg2 = new RunRegistry(fn2, { dir, botKind: "discord" });
  expect(await reg2.start(req, events(), meta)).toBe(false);
});

test("start() tracks the delegate child's own pid, so a relaunch reclaims once that child is actually dead", async () => {
  const dir = tmp();
  // Simulates a delegate handle exposing a pid that's already gone by the time anyone checks —
  // if the reservation stayed keyed to the *calling* process's pid (always alive here) instead
  // of this, it would incorrectly stay "busy" forever after interruptAll().
  const deadChildPid = 999_999;
  const fn = () => ({ cancel: () => {}, pid: deadChildPid });
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  await reg.start(req, events(), meta);
  reg.interruptAll();
  const reg2 = new RunRegistry(fn, { dir, botKind: "discord" });
  expect(await reg2.start(req, events(), meta)).toBe(true);
});
