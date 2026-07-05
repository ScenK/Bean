import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDragWatchdog } from "../src/drag-watchdog.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("fires onSilent once no drag event has armed it within silenceMs", () => {
  const onSilent = vi.fn();
  const dog = createDragWatchdog(onSilent, 800);
  dog.arm();
  vi.advanceTimersByTime(799);
  expect(onSilent).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onSilent).toHaveBeenCalledTimes(1);
});

test("re-arming (the dragover heartbeat) keeps deferring the silence deadline", () => {
  const onSilent = vi.fn();
  const dog = createDragWatchdog(onSilent, 800);
  // Chromium re-fires dragover on a stationary target every ~350ms — simulate that heartbeat.
  for (let i = 0; i < 10; i++) {
    dog.arm();
    vi.advanceTimersByTime(350);
  }
  expect(onSilent).not.toHaveBeenCalled();
  vi.advanceTimersByTime(800);
  expect(onSilent).toHaveBeenCalledTimes(1);
});

test("disarm cancels the pending deadline (drop/dragleave handled the exit)", () => {
  const onSilent = vi.fn();
  const dog = createDragWatchdog(onSilent, 800);
  dog.arm();
  dog.disarm();
  vi.advanceTimersByTime(5000);
  expect(onSilent).not.toHaveBeenCalled();
});

test("fires at most once per arm, and works again for the next drag session", () => {
  const onSilent = vi.fn();
  const dog = createDragWatchdog(onSilent, 800);
  dog.arm();
  vi.advanceTimersByTime(5000);
  expect(onSilent).toHaveBeenCalledTimes(1);
  dog.arm();
  vi.advanceTimersByTime(800);
  expect(onSilent).toHaveBeenCalledTimes(2);
});

test("disarm with nothing armed is a no-op", () => {
  const onSilent = vi.fn();
  const dog = createDragWatchdog(onSilent, 800);
  expect(() => dog.disarm()).not.toThrow();
  vi.advanceTimersByTime(5000);
  expect(onSilent).not.toHaveBeenCalled();
});
