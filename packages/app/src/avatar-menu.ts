import type { AvatarMode } from "./channels.js";

export interface Size {
  width: number;
  height: number;
}

// Preferred panel sizes; actual bounds fit the display. Tiles scroll and can open above
// the capsule. Keep windows tight to avoid blocking unnecessary desktop area.
export const AVATAR_SIZE: Size = { width: 120, height: 120 };
// Proximity/hover: just the expanded box (bean + helper text), no tiles — a short strip.
export const AVATAR_HOVER_SIZE: Size = { width: 300, height: 120 };
// Left-click quick-actions: capsule + six tiles (chat/skills/projects/notes/routines/dashboard).
export const AVATAR_MENU_SIZE: Size = { width: 300, height: 520 };
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

/** Keep a window inside a work area, including displays with negative coordinates. */
export function clampAvatarBounds(bounds: Bounds, workArea: Bounds): Bounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)),
    width, height,
  };
}

/**
 * Prefer the existing bean position. Near an edge, move the expanded panel inward so its
 * capsule and tile column fit. The caller retains the idle anchor for collapse. Tile lists
 * scroll when the display is shorter than the requested panel or there are many skills.
 */
export function dragBloomLayout(
  beanScreenCenter: Point,
  size: Size,
  workArea: Bounds,
  rightMargin = 80,
  topMargin = 44,
): { bounds: Bounds; bean: Point & { tilesAbove: boolean } } {
  const tiles = size.height > AVATAR_HOVER_SIZE.height;
  const above = beanScreenCenter.y - workArea.y;
  const below = workArea.y + workArea.height - beanScreenCenter.y;
  const tilesAbove = tiles && below < size.height - topMargin && above > below;
  // Prefer the side with room instead of moving the bean to fit a fixed downward stack.
  const available = (tilesAbove ? above : below) + topMargin;
  const height = tiles ? Math.min(size.height, Math.max(240, available)) : size.height;
  const bounds = clampAvatarBounds({
    x: beanScreenCenter.x - (size.width - rightMargin),
    y: beanScreenCenter.y - (tilesAbove ? height - topMargin : topMargin),
    width: size.width, height,
  }, workArea);
  return { bounds, bean: {
    x: clamp(beanScreenCenter.x - bounds.x, Math.min(159, bounds.width - 33), bounds.width - 33),
    y: clamp(beanScreenCenter.y - bounds.y, Math.min(topMargin, bounds.height / 2), bounds.height - topMargin),
    tilesAbove,
  } };
}

// Status bubbles (design 2a): while jobs run, the idle window grows upward to hold the bubble
// stack above the bean. The bean sits STATUS_BEAN_INSET from the right edge so the 272px bubbles
// right-align with it and the last bubble's tail points at it.
export const STATUS_WIDTH = 300;
const STATUS_BEAN_INSET = 44;

/** Window bounds holding a `stackHeight`-tall bubble stack above a bean at `bean` (screen px) —
 * or below it when the top of the screen lacks the room and the bottom has more (Bean's default
 * spot is 160px from the top). ponytail: a stack taller than either side is squeezed by the clamp. */
export function statusLayout(bean: Point, stackHeight: number, workArea: Bounds): { bounds: Bounds; bean: Point & { bubblesBelow: boolean; stackMax: number } } {
  const half = AVATAR_SIZE.height / 2;
  const height = Math.round(stackHeight) + AVATAR_SIZE.height;
  const above = bean.y - workArea.y;
  const below = workArea.y + workArea.height - bean.y;
  const bubblesBelow = above < height - half && below > above;
  const bounds = clampAvatarBounds({
    x: bean.x - (STATUS_WIDTH - STATUS_BEAN_INSET),
    y: bubblesBelow ? bean.y - half : bean.y - (height - half),
    width: STATUS_WIDTH, height,
  }, workArea);
  // The stack scrolls past the room on its side of the bean rather than outgrowing the window.
  const stackMax = Math.max(120, (bubblesBelow ? below : above) - half);
  return { bounds, bean: { x: bean.x - bounds.x, y: bean.y - bounds.y, bubblesBelow, stackMax } };
}
