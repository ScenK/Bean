import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Size { width: number; height: number }

/** One file per window kind, so each remembers its own size (chat's stays `chat-size.json`). */
export function windowSizeFile(userDataDir: string, kind: string): string {
  return join(userDataDir, `${kind}-size.json`);
}

// Component windows remember their size (not position — that stays anchored to the avatar).
// Read synchronously: the BrowserWindow is built before any renderer exists, so the size has to
// be known at construction or the window visibly jumps.
export function loadWindowSize(file: string, fallback: Size, min: Size, work: Size): Size {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    saved = undefined;
  }
  return clampWindowSize(saved, fallback, min, work);
}

// Anything but finite width+height falls back to `fallback`; the result is then kept between
// `min` and the target display's work area (the minimum wins on a tiny display).
export function clampWindowSize(saved: unknown, fallback: Size, min: Size, work: Size): Size {
  const s = saved as Partial<Size> | null | undefined;
  const valid = typeof s === "object" && s !== null &&
    Number.isFinite(s.width) && Number.isFinite(s.height);
  const size = valid ? (s as Size) : fallback;
  const fit = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, hi)));
  return {
    width: fit(size.width, min.width, work.width),
    height: fit(size.height, min.height, work.height),
  };
}

// Sync on purpose: it runs from the window's close event, which on app quit can be the last
// thing before exit — an async write could be cut off. Best-effort: a failed save only costs
// the remembered size.
export function saveWindowSize(file: string, size: Size): void {
  try {
    writeFileSync(file, JSON.stringify(size), "utf8");
  } catch {
    // ignore
  }
}
