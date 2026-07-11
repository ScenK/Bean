import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DelegateCallbacks, DelegateRequest } from "../src/index.js";
import { RunRegistry } from "../src/chatops/runs.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const req: DelegateRequest = { cli: "claude", projectPath: "/p", prompt: "do" };

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

test("second start on the same project is rejected while the first runs", () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn);
  const ev = events();
  expect(reg.start(req, ev)).toBe(true);
  expect(reg.start(req, ev)).toBe(false);
  calls[0]?.cb.onDone("result");
  expect(ev.onDone).toHaveBeenCalledWith("result");
  expect(reg.start(req, ev)).toBe(true); // freed after completion
});

test("tail lines are throttled: only the latest line flushes per interval", () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, 5000);
  const ev = events();
  reg.start(req, ev);
  calls[0]?.cb.onOutput("line 1");
  calls[0]?.cb.onOutput("line 2");
  expect(ev.onTail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(ev.onTail).toHaveBeenCalledTimes(1);
  expect(ev.onTail).toHaveBeenCalledWith("line 2");
  vi.advanceTimersByTime(5000); // no new output → no extra flush
  expect(ev.onTail).toHaveBeenCalledTimes(1);
});

test("error frees the project and reports the message", () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn);
  const ev = events();
  reg.start(req, ev);
  calls[0]?.cb.onError(new Error("boom"));
  expect(ev.onError).toHaveBeenCalledWith("boom");
  expect(reg.isRunning("/p")).toBe(false);
});

test("cancelAll cancels every active run and returns the count", () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn);
  reg.start(req, events());
  reg.start({ ...req, projectPath: "/q" }, events());
  expect(reg.cancelAll()).toBe(2);
  expect(cancelled).toHaveLength(2);
  expect(reg.cancelAll()).toBe(0);
});

test("a run that settles synchronously (spawn failure) leaves the project free", () => {
  const reg = new RunRegistry((_r, cb) => {
    cb.onError(new Error("spawn failed"));
    return { cancel: () => {} };
  });
  const ev = events();
  expect(reg.start(req, ev)).toBe(true);
  expect(ev.onError).toHaveBeenCalledWith("spawn failed");
  expect(reg.isRunning("/p")).toBe(false);
  expect(reg.start(req, events())).toBe(true); // path not stuck busy
});

test("stale callbacks from a cancelled run cannot corrupt a newer run", () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, 5000);
  const evA = events();
  reg.start(req, evA);
  reg.cancel("/p");
  const evB = events();
  expect(reg.start(req, evB)).toBe(true);
  // Run A's delegate misbehaves and fires onDone after cancel.
  calls[0]?.cb.onDone("late");
  expect(evA.onDone).not.toHaveBeenCalled();
  expect(reg.isRunning("/p")).toBe(true); // B still registered
  // B's throttle timer must still be alive.
  calls[1]?.cb.onOutput("b line");
  vi.advanceTimersByTime(5000);
  expect(evB.onTail).toHaveBeenCalledWith("b line");
});

test("cancel cancels the underlying handle and fires onCancelled", () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn);
  const ev = events();
  reg.start(req, ev);
  expect(reg.cancel("/p")).toBe(true);
  expect(cancelled).toHaveLength(1);
  expect(ev.onCancelled).toHaveBeenCalled();
  expect(reg.isRunning("/p")).toBe(false);
  expect(reg.cancel("/p")).toBe(false);
});
