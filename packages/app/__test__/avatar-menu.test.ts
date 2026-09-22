import { expect, test } from "vitest";
import { AVATAR_DRAG_SIZE, AVATAR_HOVER_SIZE, AVATAR_MENU_SIZE, AVATAR_SIZE, avatarSizeForMode, clampAvatarBounds, dragBloomLayout, nextAvatarBounds } from "../src/avatar-menu.js";

test("growing to the menu size grows the window, centered on its current position", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE.width, height: AVATAR_SIZE.height };
  const opened = nextAvatarBounds(closed, AVATAR_MENU_SIZE);
  const dx = (AVATAR_MENU_SIZE.width - AVATAR_SIZE.width) / 2;
  const dy = (AVATAR_MENU_SIZE.height - AVATAR_SIZE.height) / 2;
  expect(opened).toEqual({ x: 100 - dx, y: 100 - dy, width: AVATAR_MENU_SIZE.width, height: AVATAR_MENU_SIZE.height });
});

test("shrinking back to the normal size restores the exact original bounds", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE.width, height: AVATAR_SIZE.height };
  const opened = nextAvatarBounds(closed, AVATAR_MENU_SIZE);
  const reClosed = nextAvatarBounds(opened, AVATAR_SIZE);
  expect(reClosed).toEqual(closed);
});

test("avatarSizeForMode maps each mode to its window size", () => {
  expect(avatarSizeForMode("normal")).toEqual(AVATAR_SIZE);
  expect(avatarSizeForMode("hover")).toEqual(AVATAR_HOVER_SIZE);
  expect(avatarSizeForMode("menu")).toEqual(AVATAR_MENU_SIZE);
  expect(avatarSizeForMode("drag")).toEqual(AVATAR_DRAG_SIZE);
});

test("hover is a short strip (box only); drag is the tallest (box + full tile stack)", () => {
  expect(AVATAR_HOVER_SIZE.height).toBeLessThan(AVATAR_MENU_SIZE.height);
  expect(AVATAR_DRAG_SIZE.height).toBeGreaterThan(AVATAR_MENU_SIZE.height);
});

const WA = { x: 0, y: 0, width: 1440, height: 900 };

test("dragBloomLayout keeps the bean's screen center fixed when there's room", () => {
  const bean = { x: 700, y: 200 };
  const { bounds, bean: inWin } = dragBloomLayout(bean, AVATAR_DRAG_SIZE, WA, 80, 44);
  // the bean sits rightMargin in from the right edge and topMargin down from the top
  expect(bounds.x + inWin.x).toBe(bean.x); // in-window position maps back to the same screen point
  expect(bounds.y + inWin.y).toBe(bean.y);
  expect(inWin.x).toBe(AVATAR_DRAG_SIZE.width - 80);
  expect(inWin.y).toBe(44);
});

test.each([
  { x: 30, y: 20 }, { x: 1410, y: 20 }, { x: 30, y: 880 }, { x: 1410, y: 880 },
])("expanded panel keeps the capsule and tile column inside at $x,$y", (bean) => {
  const { bounds, bean: p } = dragBloomLayout(bean, AVATAR_MENU_SIZE, WA);
  expect(bounds.x).toBeGreaterThanOrEqual(WA.x);
  expect(bounds.y).toBeGreaterThanOrEqual(WA.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(WA.x + WA.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(WA.y + WA.height);
  expect(p.x - 151).toBeGreaterThanOrEqual(0); // expanded capsule's left edge
  expect(p.x + 25).toBeLessThanOrEqual(bounds.width);
  expect(p.y - 36).toBeGreaterThanOrEqual(0);
  expect(p.tilesAbove ? p.y - 64 - 8 : bounds.height - 8 - p.y - 64).toBeGreaterThanOrEqual(6 * 60);
});

test("short displays constrain the window and leave a viewport for scrolling tiles", () => {
  const work = { x: -1280, y: -400, width: 1280, height: 400 };
  const { bounds, bean } = dragBloomLayout({ x: -30, y: -20 }, AVATAR_DRAG_SIZE, work);
  expect(bounds.height).toBe(400);
  expect(bounds.y).toBe(-400);
  expect(bean.tilesAbove).toBe(true);
  expect(bean.y - 64 - 8).toBeGreaterThan(200);
});

test("off-screen idle bounds recover on a display with a negative origin", () => {
  expect(clampAvatarBounds({ x: 9000, y: 9000, ...AVATAR_SIZE },
    { x: -1440, y: -900, width: 1440, height: 900 })).toEqual({ x: -120, y: -120, ...AVATAR_SIZE });
});

test("bottom-edge panels open above without moving the bean vertically", () => {
  const { bounds, bean } = dragBloomLayout({ x: 800, y: 840 }, AVATAR_MENU_SIZE, WA);
  expect(bean.tilesAbove).toBe(true);
  expect(bounds.y + bean.y).toBe(840);
});
