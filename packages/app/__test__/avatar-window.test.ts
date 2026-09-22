import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";

const { ipc, displays } = vi.hoisted(() => ({ ipc: new Map<string, (...args: any[]) => void>(), displays: { work: { x: 0, y: 0, width: 1440, height: 900 } } }));
vi.mock("electron", () => ({
  ipcMain: { on: (key: string, fn: (...args: any[]) => void) => ipc.set(key, fn), removeListener: (key: string) => ipc.delete(key) },
  screen: Object.assign(new EventEmitter(), {
    getDisplayNearestPoint: () => ({ workArea: displays.work }),
    getDisplayMatching: () => ({ workArea: displays.work }),
    getCursorScreenPoint: () => ({ x: 700, y: 400 }),
  }),
}));
import { screen } from "electron";
import { installAvatarControls } from "../src/avatar-window.js";
import { IPC } from "../src/channels.js";

function fixture() {
  let bounds = { x: 700, y: 700, width: 120, height: 120 };
  const win = Object.assign(new EventEmitter(), {
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((b: typeof bounds) => { bounds = { ...b }; win.emit("moved"); }),
    isDestroyed: () => false,
    show: vi.fn(), focus: vi.fn(),
    webContents: { send: vi.fn(), getURL: () => "file:///avatar.html" },
  });
  const controls = installAvatarControls(win as unknown as BrowserWindow);
  return { win, controls, mode: (m: string) => ipc.get(IPC.setAvatarMode)!({ sender: win.webContents }, m) };
}
beforeEach(() => { vi.useFakeTimers(); displays.work = { x: 0, y: 0, width: 1440, height: 900 }; });
afterEach(() => { vi.useRealTimers(); screen.removeAllListeners(); ipc.clear(); });

test("expanded edge layout collapses to its idle anchor, including after manual movement", () => {
  const { win, mode } = fixture();
  const idle = win.getBounds();
  mode("menu");
  mode("normal");
  expect(win.getBounds()).toEqual(idle);
  mode("hover");
  ipc.get(IPC.moveWindowBy)!({ sender: win.webContents }, -100, -100);
  mode("normal");
  expect(win.getBounds()).toEqual({ ...idle, x: idle.x - 100, y: idle.y - 100 });
  win.emit("closed");
});

test("native OS movement updates the collapse anchor without a setBounds loop", () => {
  const { win, mode } = fixture();
  mode("hover");
  const b = win.getBounds();
  win.setBounds({ ...b, x: b.x - 50, y: b.y - 50 });
  mode("normal");
  expect(win.getBounds()).toMatchObject({ x: 650, y: 650 });
  expect(win.setBounds.mock.calls.length).toBeLessThan(6);
  win.emit("closed");
});

test("display removal resets drag state and anchors without unhiding the avatar", () => {
  const { win, mode } = fixture();
  mode("drag");
  displays.work = { x: -800, y: 0, width: 800, height: 600 };
  screen.emit("display-removed", {}, {});
  expect(win.getBounds()).toEqual({ x: -120, y: 480, width: 120, height: 120 });
  expect(win.webContents.send).toHaveBeenCalledWith(IPC.avatarReset);
  expect(win.show).not.toHaveBeenCalled();
  mode("hover");
  mode("normal");
  expect(win.getBounds().x).toBe(-120);
  win.emit("closed");
});

test("bring back clears expanded state and all control listeners are removed on close", () => {
  const { win, mode, controls } = fixture();
  mode("menu");
  controls.bringBack();
  expect(win.getBounds()).toEqual({ x: 1220, y: 100, width: 120, height: 120 });
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.focus).toHaveBeenCalledOnce();
  win.emit("closed");
  expect(ipc.size).toBe(0);
  expect(screen.listenerCount("display-removed")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("ordinary activation and irrelevant display metrics preserve position and open menu", () => {
  const { win, mode, controls } = fixture();
  mode("menu");
  const bounds = win.getBounds();
  win.webContents.send.mockClear();
  controls.reveal();
  screen.emit("display-metrics-changed", {}, {}, ["scaleFactor"]);
  expect(win.getBounds()).toEqual(bounds);
  expect(win.webContents.send).not.toHaveBeenCalledWith(IPC.avatarReset);
  win.emit("closed");
});

test("manual moves clamp applied bounds and do not strand the collapse anchor", () => {
  const { win, mode } = fixture();
  mode("hover");
  ipc.get(IPC.moveWindowBy)!({ sender: win.webContents }, 10000, 10000);
  const expanded = win.getBounds();
  expect(expanded.x + expanded.width).toBeLessThanOrEqual(1440);
  expect(expanded.y + expanded.height).toBeLessThanOrEqual(900);
  mode("normal");
  const idle = win.getBounds();
  expect(idle.x + idle.width).toBeLessThanOrEqual(1440);
  expect(idle.y + idle.height).toBeLessThanOrEqual(900);
  win.emit("closed");
});
