import type { BrowserWindow } from "electron";
import type { ComponentKind } from "./channels.js";

export function trackComponentWindow(
  windows: Map<ComponentKind, BrowserWindow>,
  kind: ComponentKind,
  win: BrowserWindow,
): void {
  windows.set(kind, win);
  const forget = (): void => { windows.delete(kind); };
  win.once("close", forget);
  win.once("closed", forget);
}

export function sendToWindow(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", () => sendToWindow(win, channel, payload));
    return;
  }
  win.webContents.send(channel, payload);
}
