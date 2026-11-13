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
import { AVATAR_RELOAD_TIMEOUT_MS, installAvatarControls, type AvatarRecoveryHooks } from "../src/avatar-window.js";
import { IPC } from "../src/channels.js";

function fixture(hooks: AvatarRecoveryHooks = {}, url = "file:///avatar.html") {
  let bounds = { x: 700, y: 700, width: 120, height: 120 };
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(), getURL: () => url, reload: vi.fn(), isCrashed: () => false,
  });
  const win = Object.assign(new EventEmitter(), {
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((b: typeof bounds) => { bounds = { ...b }; win.emit("moved"); }),
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    isVisible: () => true,
    show: vi.fn(), focus: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    webContents,
  });
  const controls = installAvatarControls(win as unknown as BrowserWindow, hooks);
  return { win, controls, mode: (m: string) => ipc.get(IPC.setAvatarMode)!({ sender: win.webContents }, m) };
}
const reloadListeners = (wc: EventEmitter) =>
  ["did-finish-load", "did-fail-load", "render-process-gone"].reduce((n, e) => n + wc.listenerCount(e), 0);
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
  expect(win.webContents.reload).toHaveBeenCalledOnce();
  expect(win.webContents.send).not.toHaveBeenCalledWith(IPC.avatarReset); // the fresh page starts in normal
  win.emit("closed"); // mid-reload: the timeout and load listeners go too
  expect(reloadListeners(win.webContents)).toBe(0);
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

test("status bubbles grow the idle window upward around a fixed bean, then collapse back", () => {
  const { win } = fixture();
  const idle = win.getBounds();
  const bean = { x: idle.x + 60, y: idle.y + 60 };
  const height = (h: number) => ipc.get(IPC.setAvatarStatusHeight)!({ sender: win.webContents }, h);
  height(200);
  const grown = win.getBounds();
  expect(grown).toMatchObject({ width: 300, height: 320 });
  expect(win.webContents.send).toHaveBeenLastCalledWith(IPC.avatarDragLayout, { x: bean.x - grown.x, y: bean.y - grown.y, bubblesBelow: false, stackMax: 700 });
  expect(bean.y - grown.y).toBe(260); // stack sits above the bean
  height(0);
  expect(win.getBounds()).toEqual(idle);
  win.emit("closed");
});

test("bring back replays the current jobs after the reload and ignores old-document IPC meanwhile", () => {
  let jobs = ["a"];
  const replayed: string[][] = [];
  const log = vi.fn();
  const { win, controls } = fixture({ replay: () => replayed.push(jobs), log });
  ipc.get(IPC.setAvatarStatusHeight)!({ sender: win.webContents }, 200);
  controls.bringBack();
  expect(controls.reloading()).toBe(true);
  const idle = win.getBounds();
  ipc.get(IPC.moveWindowBy)!({ sender: win.webContents }, -100, -100);
  ipc.get(IPC.setAvatarMode)!({ sender: win.webContents }, "menu");
  ipc.get(IPC.setAvatarStatusHeight)!({ sender: win.webContents }, 300);
  expect(win.getBounds()).toEqual(idle);
  controls.bringBack(); // a second click while reloading coalesces
  expect(win.webContents.reload).toHaveBeenCalledOnce();
  jobs = ["a", "b"];
  win.webContents.send.mockClear();
  win.webContents.emit("did-finish-load");
  expect(controls.reloading()).toBe(false);
  expect(replayed).toEqual([["a", "b"]]);
  expect(win.webContents.send).toHaveBeenCalledWith(IPC.avatarDragLayout, { x: 60, y: 60 });
  expect(reloadListeners(win.webContents)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(log).toHaveBeenCalledWith("bring-back", expect.objectContaining({ statusHeight: 200, crashed: false }));
  expect(log).toHaveBeenLastCalledWith("bring-back-outcome", expect.objectContaining({ outcome: "reload ok" }));
  ipc.get(IPC.setAvatarMode)!({ sender: win.webContents }, "menu"); // IPC flows again
  expect(win.getBounds()).not.toEqual(idle);
  win.emit("closed");
});

for (const [name, trigger, why] of [
  ["did-fail-load", (wc: EventEmitter) => wc.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///x", true), "failed:-6 ERR_FILE_NOT_FOUND"],
  ["render-process-gone", (wc: EventEmitter) => wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 }), "failed:crashed"],
  ["timeout", () => vi.advanceTimersByTime(AVATAR_RELOAD_TIMEOUT_MS), "timeout"],
] as const) {
  test(`bring back reports a ${name} once and cleans up`, () => {
    const fail = vi.fn();
    const replay = vi.fn();
    const { win, controls } = fixture({ fail, replay });
    controls.bringBack();
    win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///frame", false); // subframe: ignored
    trigger(win.webContents);
    vi.advanceTimersByTime(AVATAR_RELOAD_TIMEOUT_MS);
    win.webContents.emit("did-finish-load");
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(why);
    expect(replay).not.toHaveBeenCalled();
    expect(controls.reloading()).toBe(false);
    expect(reloadListeners(win.webContents)).toBe(0);
    win.emit("closed");
  });
}

// The platform is pinned: the hop is macOS-only, and CI's unit job runs on Linux.
test.each([
  ["darwin", [[true, { skipTransformProcessType: true }], [false, { skipTransformProcessType: true }]]],
  ["win32", []],
] as const)("on %s the Space hop restores per-Space visibility even when show() throws", (platform, calls) => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    const { win, controls } = fixture();
    win.show.mockImplementation(() => { throw new Error("boom"); });
    expect(() => controls.bringBack()).toThrow("boom");
    expect(win.setVisibleOnAllWorkspaces.mock.calls).toEqual(calls);
    win.emit("closed");
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

test("bring back before the page first loads is a silent no-op; a destroyed window reports failure", () => {
  const fail = vi.fn();
  const early = fixture({ fail }, "");
  early.controls.bringBack();
  expect(early.win.webContents.reload).not.toHaveBeenCalled();
  expect(early.win.show).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
  early.win.emit("closed");
  const gone = fixture({ fail });
  gone.win.destroy();
  gone.controls.bringBack();
  expect(fail).toHaveBeenCalledWith("destroyed");
  gone.win.emit("closed");
});
