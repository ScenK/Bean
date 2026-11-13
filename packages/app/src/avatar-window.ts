import { ipcMain, screen, type BrowserWindow } from "electron";
import { IPC, type AvatarMode } from "./channels.js";
import { AVATAR_SIZE, avatarSizeForMode, clampAvatarBounds, dragBloomLayout, statusLayout, type Point } from "./avatar-menu.js";

export interface AvatarRecoveryHooks {
  /** Evidence line for ~/.bean/logs/avatar.log (see avatar-log.ts). */
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Push the current job list after a reload — the fresh page starts with no bubbles. */
  replay?: () => void;
  /** Bring Bean Back couldn't restore the avatar: `destroyed`, `failed:<why>`, or `timeout`. */
  fail?: (why: string) => void;
}

// A dead or blank renderer stays "visible" with a URL, so Bring Bean Back reloads the page (#757).
export const AVATAR_RELOAD_TIMEOUT_MS = 10_000;
// Without skipTransformProcessType Electron flips the activation policy, which parks the tray on
// Tahoe (.memory/safety-tray-tahoe-placement.md). Both the on and off call need it.
const SPACE_HOP = { skipTransformProcessType: true };

/** One owner for the avatar's mode, idle anchor, native movement, and recovery. */
export function installAvatarControls(win: BrowserWindow, hooks: AvatarRecoveryHooks = {}): {
  bringBack: () => void; reveal: () => void; reloading: () => boolean;
} {
  const { log = () => {}, replay = () => {}, fail = () => {} } = hooks;
  // While the page reloads, IPC from the old document still passes the sender check: ignore it.
  let reloading = false;
  let endReload: (() => void) | undefined;
  let anchor: Point | undefined;
  let lastBounds = win.getBounds();
  let poll: ReturnType<typeof setInterval> | undefined;
  let outsideSince: number | undefined;
  let placing = false;
  let current: AvatarMode = "normal";
  // Height of the renderer's status-bubble stack (0 = no jobs). Idle/hover grow upward to hold it.
  let statusHeight = 0;
  const stopPoll = (): void => {
    clearInterval(poll);
    poll = undefined;
    outsideSince = undefined;
  };
  const place = (bounds: typeof lastBounds): void => {
    placing = true;
    // Native moved may arrive asynchronously: recording bounds here prevents a later
    // callback from shifting the anchor a second time for this programmatic move.
    try { win.setBounds(bounds); lastBounds = win.getBounds(); }
    finally { placing = false; }
  };
  const setMode = (next: AvatarMode): void => {
    stopPoll();
    const cur = win.getBounds();
    const center = anchor ?? { x: cur.x + cur.width / 2, y: cur.y + cur.height / 2 };
    const work = screen.getDisplayNearestPoint(center).workArea;
    current = next;
    if ((next === "normal" || next === "hover") && statusHeight > 0) {
      // The bean isn't at the window's center here, so keep the anchor for the eventual collapse.
      anchor = center;
      const layout = statusLayout(center, statusHeight, work);
      place(layout.bounds);
      win.webContents.send(IPC.avatarDragLayout, layout.bean);
    } else if (next === "normal") {
      const bounds = clampAvatarBounds({ x: center.x - AVATAR_SIZE.width / 2, y: center.y - AVATAR_SIZE.height / 2, ...AVATAR_SIZE }, work);
      anchor = undefined;
      place(bounds);
      win.webContents.send(IPC.avatarDragLayout, { x: bounds.width / 2, y: bounds.height / 2 });
    } else {
      anchor = center;
      const layout = dragBloomLayout(center, avatarSizeForMode(next), work);
      place(layout.bounds);
      win.webContents.send(IPC.avatarDragLayout, layout.bean);
    }
    if (next === "hover" || next === "menu") {
      const foldMs = next === "hover" ? 100 : 2000;
      poll = setInterval(() => {
        if (win.isDestroyed()) { stopPoll(); return; }
        const b = win.getBounds();
        const p = screen.getCursorScreenPoint();
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
          outsideSince = undefined;
          return;
        }
        outsideSince ??= Date.now();
        if (Date.now() - outsideSince < foldMs) return;
        win.webContents.send(IPC.avatarFoldMenu);
        stopPoll();
      }, 120);
    }
  };
  // Also observe OS drag-region moves, which never pass through moveWindowBy IPC.
  const moved = (): void => {
    if (placing || win.isDestroyed()) return;
    const cur = win.getBounds();
    const work = screen.getDisplayMatching(cur).workArea;
    const next = clampAvatarBounds(cur, work);
    if (anchor) anchor = { x: anchor.x + next.x - lastBounds.x, y: anchor.y + next.y - lastBounds.y };
    if (next.x !== cur.x || next.y !== cur.y || next.width !== cur.width || next.height !== cur.height) place(next);
    else lastBounds = cur;
  };
  win.on("moved", moved);
  const move: Parameters<typeof ipcMain.on>[1] = (e, dx: number, dy: number) => {
    if (reloading || e.sender !== win.webContents || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const cur = win.getBounds();
    const next = clampAvatarBounds({ ...cur, x: cur.x + dx, y: cur.y + dy },
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    if (anchor) anchor = { x: anchor.x + next.x - cur.x, y: anchor.y + next.y - cur.y };
    place(next);
  };
  const changeMode: Parameters<typeof ipcMain.on>[1] = (e, next: AvatarMode) => {
    if (reloading || e.sender !== win.webContents || !["normal", "hover", "menu", "drag"].includes(next)) return;
    setMode(next);
  };
  const changeStatusHeight: Parameters<typeof ipcMain.on>[1] = (e, h: number) => {
    if (reloading || e.sender !== win.webContents || !Number.isFinite(h)) return;
    const next = Math.max(0, Math.round(h));
    if (next === statusHeight) return;
    statusHeight = next;
    if (current === "normal" || current === "hover") setMode(current);
  };
  ipcMain.on(IPC.moveWindowBy, move);
  ipcMain.on(IPC.setAvatarMode, changeMode);
  ipcMain.on(IPC.setAvatarStatusHeight, changeStatusHeight);

  const reset = (center: Point): void => {
    anchor = center;
    // The renderer must discard timers/drag state before it receives the idle layout.
    win.webContents.send(IPC.avatarReset);
    setMode("normal");
  };
  const recoverDisplay = (): void => {
    if (win.isDestroyed() || !win.webContents.getURL()) return;
    const b = win.getBounds();
    const fixed = clampAvatarBounds(b, screen.getDisplayMatching(b).workArea);
    if (fixed.x === b.x && fixed.y === b.y && fixed.width === b.width && fixed.height === b.height) return;
    reset(anchor ?? { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  };
  screen.on("display-removed", recoverDisplay);
  screen.on("display-metrics-changed", recoverDisplay);
  const snapshot = (): Record<string, unknown> => {
    const bounds = win.getBounds();
    return { destroyed: false, visible: win.isVisible(), crashed: win.webContents.isCrashed(), bounds,
      display: screen.getDisplayMatching(bounds).workArea, mode: current, statusHeight, anchor: anchor ?? null };
  };
  // Always reloads (also covers a live renderer that stopped painting), then hops to this Space.
  const bringBack = (): void => {
    if (win.isDestroyed()) {
      log("bring-back", { destroyed: true });
      log("bring-back-outcome", { outcome: "failed:destroyed", ms: 0 });
      fail("destroyed");
      return;
    }
    // An empty URL = the page hasn't loaded yet at boot; nothing to recover.
    if (!win.webContents.getURL() || reloading) return;
    log("bring-back", snapshot());
    // The fresh page starts in "normal" with no bubbles, so reset main's side to match.
    stopPoll();
    current = "normal";
    statusHeight = 0;
    anchor = undefined;
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    place(clampAvatarBounds({ x: work.x + work.width - 220, y: work.y + 100, ...AVATAR_SIZE }, work));
    reloading = true;
    const wc = win.webContents;
    const started = Date.now();
    const loaded = (): void => finish();
    const failedLoad = (_e: unknown, code: number, desc: string, _url: string, mainFrame: boolean): void => {
      if (mainFrame) finish(`failed:${code} ${desc}`);
    };
    const gone = (_e: unknown, d: { reason: string }): void => finish(`failed:${d.reason}`);
    const timer = setTimeout(() => finish("timeout"), AVATAR_RELOAD_TIMEOUT_MS);
    endReload = () => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", loaded);
      wc.removeListener("did-fail-load", failedLoad);
      wc.removeListener("render-process-gone", gone);
      reloading = false;
      endReload = undefined;
    };
    function finish(failure?: string): void {
      endReload?.();
      log("bring-back-outcome", { outcome: failure ?? "reload ok", ms: Date.now() - started });
      if (failure) { fail(failure); return; }
      setMode("normal"); // idle layout first, then the jobs; the renderer reports the bubble height
      replay();
    }
    wc.on("did-finish-load", loaded);
    wc.on("did-fail-load", failedLoad);
    wc.on("render-process-gone", gone);
    try { wc.reload(); } catch (err) { finish(`failed:${err instanceof Error ? err.message : "reload"}`); }
    // The Space hop is macOS-only (Spaces); elsewhere a plain show.
    const hop = process.platform === "darwin";
    try {
      if (hop) win.setVisibleOnAllWorkspaces(true, SPACE_HOP);
      win.show();
    } finally {
      if (hop) win.setVisibleOnAllWorkspaces(false, SPACE_HOP);
    }
    win.focus();
  };
  win.on("closed", () => {
    endReload?.();
    stopPoll();
    ipcMain.removeListener(IPC.moveWindowBy, move);
    ipcMain.removeListener(IPC.setAvatarMode, changeMode);
    ipcMain.removeListener(IPC.setAvatarStatusHeight, changeStatusHeight);
    screen.removeListener("display-removed", recoverDisplay);
    screen.removeListener("display-metrics-changed", recoverDisplay);
  });
  const reveal = (): void => {
    if (win.isDestroyed() || !win.webContents.getURL()) return;
    recoverDisplay();
    win.show();
    win.focus();
  };
  return { bringBack, reveal, reloading: () => reloading };
}
