import { expect, test } from "vitest";
import { AVATAR_DRAG_SIZE, AVATAR_HOVER_SIZE, AVATAR_MENU_SIZE, AVATAR_SIZE, avatarSizeForMode, dragBloomLayout, nextAvatarBounds } from "../src/avatar-menu.js";

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
  const bean = { x: 700, y: 300 };
  const { bounds, bean: inWin } = dragBloomLayout(bean, AVATAR_DRAG_SIZE, WA, 80, 44);
  // the bean sits rightMargin in from the right edge and topMargin down from the top
  expect(bounds.x + inWin.x).toBe(bean.x); // in-window position maps back to the same screen point
  expect(bounds.y + inWin.y).toBe(bean.y);
  expect(inWin.x).toBe(AVATAR_DRAG_SIZE.width - 80);
  expect(inWin.y).toBe(44);
});

test("dragBloomLayout clamps the window (not the bean) near a screen corner", () => {
  const bean = { x: 30, y: 20 }; // top-left corner
  const { bounds, bean: inWin } = dragBloomLayout(bean, AVATAR_DRAG_SIZE, WA, 80, 44);
  expect(bounds.x).toBe(WA.x); // window pinned to the work area, doesn't go off-screen
  expect(bounds.y).toBe(WA.y);
  // the bean's on-screen position is still exactly where it was (no jump)
  expect(bounds.x + inWin.x).toBe(bean.x);
  expect(bounds.y + inWin.y).toBe(bean.y);
});
