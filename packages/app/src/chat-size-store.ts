import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Size { width: number; height: number }

export const CHAT_DEFAULT_SIZE: Size = { width: 820, height: 760 };
export const CHAT_MIN_SIZE: Size = { width: 440, height: 520 };

export function chatSizeFile(userDataDir: string): string {
  return join(userDataDir, "chat-size.json");
}

// The chat window remembers its size (not position — that stays anchored to the avatar).
// Read synchronously: the BrowserWindow is built before any renderer exists, so the size has to
// be known at construction or the window visibly jumps.
export function loadChatSize(file: string, work: Size): Size {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    saved = undefined;
  }
  return clampChatSize(saved, work);
}

// Anything but finite width+height falls back to the default; the result is then kept between
// the chat minimum and the target display's work area (the minimum wins on a tiny display).
export function clampChatSize(saved: unknown, work: Size): Size {
  const s = saved as Partial<Size> | null | undefined;
  const valid = typeof s === "object" && s !== null &&
    Number.isFinite(s.width) && Number.isFinite(s.height);
  const size = valid ? (s as Size) : CHAT_DEFAULT_SIZE;
  const fit = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(v, max)));
  return {
    width: fit(size.width, CHAT_MIN_SIZE.width, work.width),
    height: fit(size.height, CHAT_MIN_SIZE.height, work.height),
  };
}

// Sync on purpose: it runs from the window's close event, which on app quit can be the last
// thing before exit — an async write could be cut off. Best-effort: a failed save only costs
// the remembered size.
export function saveChatSize(file: string, size: Size): void {
  try {
    writeFileSync(file, JSON.stringify(size), "utf8");
  } catch {
    // ignore
  }
}
