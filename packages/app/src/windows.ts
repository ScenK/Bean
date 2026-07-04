import { BrowserWindow, screen, type Rectangle } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ComponentKind } from "./channels.js";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "preload.cjs");
const renderer = (name: string) => join(here, "renderer", `${name}.html`);

// Most component windows share one dashboard-sized default; the Plan window is a compact
// confirm card, not a dashboard, so it gets its own size (roomy enough for a full composed
// prompt — skill body + instruction + dropped URL — without immediately needing to resize).
const COMPONENT_WINDOW_SIZE: Record<ComponentKind, { width: number; height: number }> = {
  chat: { width: 520, height: 640 },
  skills: { width: 1040, height: 720 },
  persona: { width: 420, height: 560 },
  projects: { width: 1040, height: 720 },
  notes: { width: 1040, height: 720 },
  plan: { width: 640, height: 620 },
  settings: { width: 480, height: 560 },
  about: { width: 420, height: 380 },
};

const COMPONENT_WINDOW_TITLE: Record<ComponentKind, string> = {
  chat: "Chat",
  skills: "Skills",
  persona: "Persona",
  projects: "Projects",
  notes: "Notes",
  plan: "Plan",
  settings: "Settings",
  about: "About Bean",
};

// Default spawn spot: top-right of the primary display, inset so the bean doesn't sit flush
// against either edge.
const START_SIZE = { width: 120, height: 120 };
const START_MARGIN = 100;
function startPosition(): { x: number; y: number } {
  const work = screen.getPrimaryDisplay().workArea;
  return { x: work.x + work.width - START_SIZE.width - START_MARGIN, y: work.y + START_MARGIN };
}

export function createAvatarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...START_SIZE, ...startPosition(), frame: false, transparent: true,
    backgroundColor: "#00000000", hasShadow: false,
    alwaysOnTop: true, resizable: false,
    webPreferences: { preload },
  });
  void win.loadFile(renderer("avatar"));
  return win;
}

// Places a new window just to the left of the bean (the avatar sits top-right), then clamps
// to the work area of whichever display the bean is on and nudges down if it would still
// overlap the bean's body.
const ANCHOR_GAP = 12;
function nearAnchor(anchor: Rectangle, size: { width: number; height: number }): { x: number; y: number } {
  const work = screen.getDisplayMatching(anchor).workArea;
  let x = anchor.x - size.width - ANCHOR_GAP;
  if (x < work.x) x = anchor.x + anchor.width + ANCHOR_GAP; // bean near left edge instead: open to its right
  x = Math.min(Math.max(x, work.x), work.x + work.width - size.width);

  let y = anchor.y;
  y = Math.min(Math.max(y, work.y), work.y + work.height - size.height);

  const overlapsAnchor = x < anchor.x + anchor.width && x + size.width > anchor.x &&
    y < anchor.y + anchor.height && y + size.height > anchor.y;
  if (overlapsAnchor) {
    y = Math.min(anchor.y + anchor.height + ANCHOR_GAP, work.y + work.height - size.height);
  }

  return { x, y };
}

export function createComponentWindow(kind: ComponentKind, anchor?: Rectangle): BrowserWindow {
  const size = COMPONENT_WINDOW_SIZE[kind];
  const win = new BrowserWindow({
    ...size,
    ...(anchor ? nearAnchor(anchor, size) : {}),
    title: COMPONENT_WINDOW_TITLE[kind],
    titleBarStyle: "hiddenInset",
    webPreferences: { preload },
  });
  void win.loadFile(renderer(kind));
  return win;
}
