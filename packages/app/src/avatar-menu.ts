import type { AvatarMode } from "./channels.js";

export interface Size {
  width: number;
  height: number;
}

// Per-mode grown-window sizes. The bean lives in the top-right; the box + tiles grow down and
// to the left, so windows are wide enough for the box and tall enough for the tile stack. Kept
// as tight as possible so the transparent window blocks as little of the desktop as it can.
export const AVATAR_SIZE: Size = { width: 120, height: 120 };
// Proximity/hover: just the expanded box (bean + helper text), no tiles — a short strip.
export const AVATAR_HOVER_SIZE: Size = { width: 300, height: 120 };
// Left-click quick-actions: box + 4 tiles (chat/skills/projects/notes) — first tile center
// 92px below the box, 60px steps, so the 4th tile ends ~390px down.
export const AVATAR_MENU_SIZE: Size = { width: 300, height: 400 };
// Drag-skill bloom: box + a taller stack of skill/quick-action tiles.
export const AVATAR_DRAG_SIZE: Size = { width: 300, height: 620 };

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the avatar window's next bounds when it grows/shrinks to a new target size. Grows/
 * shrinks symmetrically around the window's current center so the bean itself doesn't visually
 * jump (fallback path when there's no bean anchor to grow away from yet).
 */
export function nextAvatarBounds(current: Bounds, target: Size): Bounds {
  const dx = (target.width - current.width) / 2;
  const dy = (target.height - current.height) / 2;
  return { x: current.x - dx, y: current.y - dy, width: target.width, height: target.height };
}

export function avatarSizeForMode(mode: AvatarMode): Size {
  if (mode === "hover") return AVATAR_HOVER_SIZE;
  if (mode === "menu") return AVATAR_MENU_SIZE;
  if (mode === "drag") return AVATAR_DRAG_SIZE;
  return AVATAR_SIZE;
}

export interface Point {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * Layout for the grown avatar (hover box, quick-actions menu, drag-skill bloom). Keeps the
 * bean's on-screen center fixed — so it never "jumps" when the window grows — by sitting it
 * `rightMargin` in from the grown window's right edge and `topMargin` down from the top (box +
 * tiles grow downward and to the left), then clamping the *window* to the work area so it can't
 * land off-screen. Returns the window bounds plus the bean's resulting center *within* that
 * window, which the renderer uses to place the box and lay out the tiles. When the bean is near
 * an edge the clamp shifts the window (not the bean), so some tiles may fall outside — but the
 * bean stays put, which is what matters.
 */
export function dragBloomLayout(
  beanScreenCenter: Point,
  size: Size,
  workArea: Bounds,
  rightMargin = 80,
  topMargin = 44,
): { bounds: Bounds; bean: Point } {
  const x = clamp(beanScreenCenter.x - (size.width - rightMargin), workArea.x, workArea.x + Math.max(0, workArea.width - size.width));
  const y = clamp(beanScreenCenter.y - topMargin, workArea.y, workArea.y + Math.max(0, workArea.height - size.height));
  return { bounds: { x, y, width: size.width, height: size.height }, bean: { x: beanScreenCenter.x - x, y: beanScreenCenter.y - y } };
}
