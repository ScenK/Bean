import { ipcMain, screen, type BrowserWindow } from "electron";
import { IPC, type AvatarMode } from "./channels.js";
import { AVATAR_SIZE, avatarSizeForMode, clampAvatarBounds, dragBloomLayout, type Point } from "./avatar-menu.js";

/** One owner for the avatar's mode, idle anchor, native movement, and recovery. */
export function installAvatarControls(win: BrowserWindow): { bringBack: () => void; reveal: () => void } {
  let anchor: Point | undefined;
  let lastBounds = win.getBounds();
  let poll: ReturnType<typeof setInterval> | undefined;
  let outsideSince: number | undefined;
  let placing = false;
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
    if (next === "normal") {
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
    if (e.sender !== win.webContents || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const cur = win.getBounds();
    const next = clampAvatarBounds({ ...cur, x: cur.x + dx, y: cur.y + dy },
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    if (anchor) anchor = { x: anchor.x + next.x - cur.x, y: anchor.y + next.y - cur.y };
    place(next);
  };
  const changeMode: Parameters<typeof ipcMain.on>[1] = (e, next: AvatarMode) => {
    if (e.sender !== win.webContents || !["normal", "hover", "menu", "drag"].includes(next)) return;
    setMode(next);
  };
  ipcMain.on(IPC.moveWindowBy, move);
  ipcMain.on(IPC.setAvatarMode, changeMode);

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
  const bringBack = (): void => {
    if (win.isDestroyed() || !win.webContents.getURL()) return;
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    reset({ x: work.x + work.width - 160, y: work.y + 160 });
    win.show();
    win.focus();
  };
  win.on("closed", () => {
    stopPoll();
    ipcMain.removeListener(IPC.moveWindowBy, move);
    ipcMain.removeListener(IPC.setAvatarMode, changeMode);
    screen.removeListener("display-removed", recoverDisplay);
    screen.removeListener("display-metrics-changed", recoverDisplay);
  });
  const reveal = (): void => {
    if (win.isDestroyed() || !win.webContents.getURL()) return;
    recoverDisplay();
    win.show();
    win.focus();
  };
  return { bringBack, reveal };
}
