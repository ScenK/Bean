import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { sendToWindow, trackComponentWindow } from "../src/component-window-registry.js";

test("forgets a component window as soon as it starts closing", () => {
  const windows = new Map();
  const win = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean };
  win.isDestroyed = () => false;

  trackComponentWindow(windows, "plan", win);
  win.emit("close");

  expect(windows.has("plan")).toBe(false);
});

test("sendToWindow skips destroyed windows", () => {
  const sent: unknown[] = [];
  const win = {
    isDestroyed: () => true,
    webContents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      once: () => {},
      send: (...args: unknown[]) => { sent.push(args); },
    },
  };

  sendToWindow(win as never, "channel", "payload");

  expect(sent).toEqual([]);
});

test("sendToWindow re-checks before sending after load", () => {
  const sent: unknown[] = [];
  let loading = true;
  let destroyed = false;
  let onLoad: (() => void) | undefined;
  const win = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => loading,
      once: (_event: string, cb: () => void) => { onLoad = cb; },
      send: (...args: unknown[]) => { sent.push(args); },
    },
  };

  sendToWindow(win as never, "channel", "payload");
  loading = false;
  destroyed = true;
  onLoad?.();

  expect(sent).toEqual([]);
});
