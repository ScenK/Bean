import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ComponentKind } from "./channels.js";
import { loadWindowSize, saveWindowSize, windowSizeFile, type Size } from "./window-size-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "preload.cjs");
const renderer = (name: string) => join(here, "renderer", `${name}.html`);

// First-open sizes; after that each kind reopens at its own remembered size. The list-and-detail
// panels share the Dashboard's size; the Plan window is a compact confirm card, not a dashboard,
// so it gets its own size (roomy enough for a full composed prompt — skill body + instruction +
// dropped URL — without immediately needing to resize).
const PANEL_SIZE: Size = { width: 1200, height: 780 };
const COMPONENT_WINDOW_SIZE: Record<ComponentKind, Size> = {
  chat: { width: 820, height: 760 },
  skills: PANEL_SIZE,
  persona: { width: 420, height: 560 },
  projects: PANEL_SIZE,
  notes: PANEL_SIZE,
  plan: { width: 640, height: 620 },
  settings: { width: 560, height: 680 },
  about: { width: 420, height: 380 },
  routines: PANEL_SIZE,
  dashboard: PANEL_SIZE,
  cores: { width: 440, height: 520 },
};
// Chat's composer and transcript need room; the rest only need to stay usable.
const CHAT_MIN_SIZE: Size = { width: 440, height: 520 };
const WINDOW_MIN_SIZE: Size = { width: 320, height: 240 };

const COMPONENT_WINDOW_TITLE: Record<ComponentKind, string> = {
  chat: "Chat",
  skills: "Skills",
  persona: "Persona",
  projects: "Projects",
  notes: "Notes",
  plan: "Plan",
  settings: "Settings",
  about: "About Bean",
  routines: "Sprouts",
  dashboard: "Dashboard",
  cores: "Cores",
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
    alwaysOnTop: true, resizable: false, show: false,
    webPreferences: { preload },
  });
  return win;
}

// Load only after main has registered IPC, so the renderer's first requests cannot race boot.
export async function loadAvatarWindow(win: BrowserWindow): Promise<void> {
  await win.loadFile(renderer("avatar"));
  win.show();
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
  // Each kind remembers its own size (clamped before nearAnchor places it).
  const sizeFile = windowSizeFile(app.getPath("userData"), kind);
  const work = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea;
  const min = kind === "chat" ? CHAT_MIN_SIZE : WINDOW_MIN_SIZE;
  const size = loadWindowSize(sizeFile, COMPONENT_WINDOW_SIZE[kind], min, work);
  const win = new BrowserWindow({
    ...size,
    minWidth: min.width,
    minHeight: min.height,
    ...(anchor ? nearAnchor(anchor, size) : {}),
    title: COMPONENT_WINDOW_TITLE[kind],
    // macOS insets the traffic lights into the content; elsewhere "hidden" would drop the window
    // controls, so Windows keeps its native frame.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    // Windows would show Electron's default File/Edit/View bar in every window; Alt still reveals it.
    autoHideMenuBar: true,
    webPreferences: { preload },
    // Shown once painted: an immediately-shown window flashes blank before its first frame.
    show: false,
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    const [width = 0, height = 0] = win.getSize();
    saveWindowSize(sizeFile, { width, height });
  });
  void win.loadFile(renderer(kind));
  return win;
}
