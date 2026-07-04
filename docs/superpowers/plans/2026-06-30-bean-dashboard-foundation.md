# Bean Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bean's intake/console windows with a single themeable dashboard window, add a shared animated avatar/orb component, and lay the empty-panel shell that later sub-projects will fill in.

**Architecture:** The floating avatar window (`avatar.html`) keeps its current always-on-top/transparent/draggable behavior but never navigates again — double-click or drop now asks the main process to open (or focus) a new `dashboard.html` window via IPC. Both windows share a CSS-custom-property theme system (`hearth`/`graphite`) persisted in Electron's `userData` dir and broadcast to all windows on change, and a shared vanilla-DOM `orb.ts` component for the avatar visual. The dashboard itself is a small Preact app (new dependency, dashboard-only) rendering a title bar and a 2-column grid of six placeholder panels.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax`), Electron, esbuild, Preact (new, dashboard renderer only), Vitest.

## Global Constraints

- No new test-framework dependency — this repo has no DOM-testing infra (jsdom/testing-library) today and this plan doesn't add one. UI correctness for CSS/DOM-heavy files (`orb.ts`, avatar/dashboard renderers) is verified manually via `pnpm dev`, not via automated tests.
- Preact is added as a dependency of `@bean/app` only, used only by the dashboard renderer. The avatar renderer stays vanilla TS/DOM.
- Theme preference is persisted in a JSON file under Electron's `app.getPath("userData")`, owned entirely by `packages/app`. It is never added to `@bean/core`'s `BeanConfig` or `~/.bean/config.json`.
- IPC channel names are always defined in `packages/app/src/channels.ts` and referenced via the `IPC` object — never string-literaled at call sites (existing repo convention).
- The dashboard window uses the OS-native window frame (`frame` left at its Electron default — i.e. not set to `false`). The in-content title bar (traffic lights, "File"/"View" text, mini orb, theme toggle) is purely decorative chrome matching the mockup's look; it does not implement real window controls (close/minimize/drag) in this plan.
- `intake.html`/`intake.ts` and `console.html`/`console.ts` are deleted outright, not kept as dead code or a fallback path.
- `pnpm test && pnpm typecheck` (run from the repo root) must both exit 0 before the final task's commit.

---

### Task 1: Theme type, IPC channel constants, and theme persistence

**Files:**
- Modify: `packages/app/src/channels.ts`
- Create: `packages/app/src/theme-store.ts`
- Test: `packages/app/__test__/theme-store.test.ts`

**Interfaces:**
- Produces: `type Theme = "hearth" | "graphite"` (in `channels.ts`); `IPC.getTheme`, `IPC.setTheme`, `IPC.themeChanged`, `IPC.openDashboard`, `IPC.dashboardDroppedUrl` (string channel names, in `channels.ts`); `DEFAULT_THEME: Theme`, `themeFile(userDataDir: string): string`, `loadTheme(file: string): Promise<Theme>`, `saveTheme(file: string, theme: Theme): Promise<void>` (in `theme-store.ts`).

- [x] **Step 1: Update `channels.ts` with the new `Theme` type and channel names**

```typescript
export type Theme = "hearth" | "graphite";

export const IPC = {
  route: "bean:route",
  run: "bean:run",
  runEvent: "bean:run-event",
  getTheme: "bean:get-theme",
  setTheme: "bean:set-theme",
  themeChanged: "bean:theme-changed",
  openDashboard: "bean:open-dashboard",
  dashboardDroppedUrl: "bean:dashboard-dropped-url",
} as const;
```

- [x] **Step 2: Write the failing test for `theme-store.ts`**

```typescript
import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THEME, loadTheme, saveTheme, themeFile } from "../src/theme-store.js";

test("loadTheme returns the default when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const theme = await loadTheme(themeFile(dir));
    expect(theme).toBe(DEFAULT_THEME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveTheme then loadTheme round-trips a non-default theme", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const file = themeFile(dir);
    await saveTheme(file, "graphite");
    const theme = await loadTheme(file);
    expect(theme).toBe("graphite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTheme falls back to the default on invalid file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const file = themeFile(dir);
    await saveTheme(file, "graphite");
    await writeFile(file, "not json", "utf8");
    const theme = await loadTheme(file);
    expect(theme).toBe(DEFAULT_THEME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Save this as `packages/app/__test__/theme-store.test.ts`.

- [x] **Step 3: Run the test and verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/theme-store.test.ts`
Expected: FAIL — `Cannot find module '../src/theme-store.js'`

- [x] **Step 4: Implement `theme-store.ts`**

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Theme } from "./channels.js";

export const DEFAULT_THEME: Theme = "hearth";

export function themeFile(userDataDir: string): string {
  return join(userDataDir, "theme.json");
}

export async function loadTheme(file: string): Promise<Theme> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { theme?: string };
    return parsed.theme === "graphite" ? "graphite" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export async function saveTheme(file: string, theme: Theme): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ theme }), "utf8");
}
```

- [x] **Step 5: Run the test and verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/theme-store.test.ts`
Expected: PASS (3 tests)

- [x] **Step 6: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/theme-store.ts packages/app/__test__/theme-store.test.ts
git commit -m "feat(app): add theme type, IPC channels, and theme persistence"
```

---

### Task 2: Theme and dashboard IPC handlers

**Files:**
- Modify: `packages/app/src/ipc.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `Theme` (Task 1, `channels.ts`).
- Produces: `ThemeHandlerDeps` interface (`getCurrentTheme: () => Theme`, `setCurrentTheme: (theme: Theme) => Promise<void>`); `buildThemeHandlers(deps: ThemeHandlerDeps): { get(): Theme; set(theme: Theme): Promise<void> }`; `RegisterDeps` extended with `broadcast: (channel: string, payload: unknown) => void` and `openDashboard: (droppedUrl?: string) => void`.

- [x] **Step 1: Write the failing test for `buildThemeHandlers`**

Append to `packages/app/__test__/ipc.test.ts` (add `vi` to the existing `vitest` import):

```typescript
import { expect, test, vi } from "vitest";
import { buildRouteHandler, buildThemeHandlers } from "../src/ipc.js";
import type { Project, RouteSuggestion, Skill } from "@bean/core";

// ...existing "route handler wires core pieces together" test stays as-is...

test("theme handlers read and write through the injected deps", async () => {
  let current: "hearth" | "graphite" = "hearth";
  const setCurrentTheme = vi.fn(async (t: "hearth" | "graphite") => { current = t; });
  const handlers = buildThemeHandlers({ getCurrentTheme: () => current, setCurrentTheme });

  expect(handlers.get()).toBe("hearth");
  await handlers.set("graphite");
  expect(setCurrentTheme).toHaveBeenCalledWith("graphite");
  expect(handlers.get()).toBe("graphite");
});
```

- [x] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildThemeHandlers is not exported from '../src/ipc.js'`

- [x] **Step 3: Implement the theme handlers and extend `RegisterDeps` in `ipc.ts`**

```typescript
import {
  route, runOpencode,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
} from "@bean/core";
import type { RouterDeps } from "@bean/core";
import type { IpcMain, WebContents } from "electron";
import { IPC, type Theme } from "./channels.js";

export { IPC };

export interface RouteHandlerDeps {
  loadSkills: (dir: string) => Promise<Skill[]>;
  loadProjects: (file: string) => Promise<Project[]>;
  chat: RouterDeps["chat"];
  model: string;
  skillsDir: string;
  projectsFile: string;
}

export function buildRouteHandler(deps: RouteHandlerDeps) {
  return async (input: RouteInput): Promise<RouteSuggestion> => {
    const [skills, projects] = await Promise.all([
      deps.loadSkills(deps.skillsDir),
      deps.loadProjects(deps.projectsFile),
    ]);
    return route(input, skills, projects, { chat: deps.chat, model: deps.model });
  };
}

export interface ThemeHandlerDeps {
  getCurrentTheme: () => Theme;
  setCurrentTheme: (theme: Theme) => Promise<void>;
}

export function buildThemeHandlers(deps: ThemeHandlerDeps) {
  return {
    get: (): Theme => deps.getCurrentTheme(),
    set: async (theme: Theme): Promise<void> => { await deps.setCurrentTheme(theme); },
  };
}

export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  sender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openDashboard: (droppedUrl?: string) => void;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));
  ipcMain.handle(IPC.run, async (_e, suggestion: RouteSuggestion) =>
    runOpencode(suggestion, (event) => deps.sender()?.send(IPC.runEvent, event)),
  );

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.broadcast(IPC.themeChanged, next);
  });

  ipcMain.handle(IPC.openDashboard, (_e, droppedUrl?: string) => deps.openDashboard(droppedUrl));
}
```

- [x] **Step 4: Run the test and verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: PASS (2 tests)

- [x] **Step 5: Commit**

```bash
git add packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): add theme and open-dashboard IPC handlers"
```

---

### Task 3: Preload bridge and renderer type declarations

**Files:**
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`

**Interfaces:**
- Consumes: `IPC`, `Theme` (Task 1).
- Produces: `window.bean.getTheme()`, `window.bean.setTheme()`, `window.bean.onThemeChanged()`, `window.bean.openDashboard()`, `window.bean.onDashboardDroppedUrl()`.

- [x] **Step 1: Update `preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Theme } from "./channels.js";
import type { RouteInput, RouteSuggestion, RunEvent } from "@bean/core";

contextBridge.exposeInMainWorld("bean", {
  route: (input: RouteInput): Promise<RouteSuggestion> => ipcRenderer.invoke(IPC.route, input),
  run: (s: RouteSuggestion): Promise<string> => ipcRenderer.invoke(IPC.run, s),
  onRunEvent: (cb: (e: RunEvent) => void) =>
    ipcRenderer.on(IPC.runEvent, (_e, ev: RunEvent) => cb(ev)),
  getTheme: (): Promise<Theme> => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (t: Theme): Promise<void> => ipcRenderer.invoke(IPC.setTheme, t),
  onThemeChanged: (cb: (t: Theme) => void) =>
    ipcRenderer.on(IPC.themeChanged, (_e, t: Theme) => cb(t)),
  openDashboard: (droppedUrl?: string): Promise<void> => ipcRenderer.invoke(IPC.openDashboard, droppedUrl),
  onDashboardDroppedUrl: (cb: (url: string) => void) =>
    ipcRenderer.on(IPC.dashboardDroppedUrl, (_e, url: string) => cb(url)),
});
```

- [x] **Step 2: Update `bean.d.ts`**

```typescript
import type { RouteInput, RouteSuggestion, RunEvent } from "@bean/core";
import type { Theme } from "../channels.js";

declare global {
  interface Window {
    bean: {
      route(input: RouteInput): Promise<RouteSuggestion>;
      run(s: RouteSuggestion): Promise<string>;
      onRunEvent(cb: (e: RunEvent) => void): void;
      getTheme(): Promise<Theme>;
      setTheme(t: Theme): Promise<void>;
      onThemeChanged(cb: (t: Theme) => void): void;
      openDashboard(droppedUrl?: string): Promise<void>;
      onDashboardDroppedUrl(cb: (url: string) => void): void;
    };
  }
}

export {};
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: exits 0

- [x] **Step 4: Commit**

```bash
git add packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts
git commit -m "feat(app): expose theme and dashboard IPC on window.bean"
```

---

### Task 4: Window creation and main-process wiring

**Files:**
- Modify: `packages/app/src/windows.ts`
- Modify: `packages/app/src/main.ts`

**Interfaces:**
- Consumes: `registerIpc`, `RegisterDeps` (Task 2); `loadTheme`, `saveTheme`, `themeFile` (Task 1); `IPC` (Task 1).
- Produces: `createDashboardWindow(droppedUrl?: string): BrowserWindow` (replaces `createConsoleWindow`).

- [x] **Step 1: Replace `createConsoleWindow` with `createDashboardWindow` in `windows.ts`**

```typescript
import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "preload.cjs");
const renderer = (name: string) => join(here, "renderer", `${name}.html`);

export function createAvatarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 120, height: 120, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    webPreferences: { preload },
  });
  void win.loadFile(renderer("avatar"));
  return win;
}

export function createDashboardWindow(droppedUrl?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040, height: 720,
    webPreferences: { preload },
  });
  void win.loadFile(renderer("dashboard"), droppedUrl ? { query: { droppedUrl } } : undefined);
  return win;
}
```

- [x] **Step 2: Rewrite `main.ts`**

```typescript
import { app, ipcMain, dialog, BrowserWindow } from "electron";
import {
  beanDir, configFile, projectsFile, skillsDir,
  loadConfig, loadSkills, loadProjects, makeOpenAIChat,
} from "@bean/core";
import { createAvatarWindow, createDashboardWindow } from "./windows.js";
import { registerIpc } from "./ipc.js";
import { IPC, type Theme } from "./channels.js";
import { loadTheme, saveTheme, themeFile } from "./theme-store.js";

app.whenReady().then(async () => {
  const dir = beanDir();
  const avatar = createAvatarWindow();
  avatar.on("closed", () => { /* keep app */ });

  let dashboardWin: BrowserWindow | undefined;
  const openDashboard = (droppedUrl?: string): void => {
    if (dashboardWin && !dashboardWin.isDestroyed()) {
      dashboardWin.focus();
      if (droppedUrl) dashboardWin.webContents.send(IPC.dashboardDroppedUrl, droppedUrl);
      return;
    }
    dashboardWin = createDashboardWindow(droppedUrl);
    dashboardWin.on("closed", () => { dashboardWin = undefined; });
  };

  const themePath = themeFile(app.getPath("userData"));
  let currentTheme: Theme = await loadTheme(themePath);
  const getCurrentTheme = (): Theme => currentTheme;
  const setCurrentTheme = async (theme: Theme): Promise<void> => {
    currentTheme = theme;
    await saveTheme(themePath, theme);
  };
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };

  try {
    const cfg = await loadConfig(configFile(dir), dir);
    if (cfg.openaiApiKey === "") {
      dialog.showErrorBox("Bean", "Missing openaiApiKey in ~/.bean/config.json");
    }
    registerIpc(ipcMain, {
      loadSkills, loadProjects,
      chat: makeOpenAIChat(cfg.openaiApiKey),
      model: cfg.model,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      sender: () => dashboardWin?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openDashboard,
    });
  } catch (err) {
    dialog.showErrorBox("Bean", err instanceof Error ? err.message : String(err));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: exits 0

- [x] **Step 4: Commit**

```bash
git add packages/app/src/windows.ts packages/app/src/main.ts
git commit -m "feat(app): replace console window with dashboard window + theme state"
```

---

### Task 5: Tooling — Preact, JSX config, and dashboard bootstrap skeleton

**Files:**
- Modify: `packages/app/package.json`
- Modify: `packages/app/tsconfig.json`
- Modify: `packages/app/esbuild.config.mjs`
- Delete: `packages/app/src/renderer/intake.html`, `packages/app/src/renderer/intake.ts`, `packages/app/src/renderer/console.html`, `packages/app/src/renderer/console.ts`
- Create: `packages/app/src/renderer/dashboard.html`
- Create: `packages/app/src/renderer/dashboard.tsx`

**Interfaces:**
- Produces: a buildable, empty `dashboard.html`/`dashboard.js` pair that later tasks fill in.

- [x] **Step 1: Add `preact` to `packages/app/package.json`**

```json
{
  "name": "@bean/app",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "start": "electron dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@bean/core": "workspace:*",
    "preact": "latest"
  },
  "devDependencies": {
    "electron": "latest",
    "esbuild": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "@types/node": "latest"
  }
}
```

- [x] **Step 2: Install**

Run: `pnpm install`
Expected: exits 0, `preact` appears under `packages/app/node_modules` (or hoisted root `node_modules`)

- [x] **Step 3: Add JSX options to `packages/app/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  },
  "include": ["src"]
}
```

- [x] **Step 4: Delete the intake and console renderer files**

```bash
git rm packages/app/src/renderer/intake.html packages/app/src/renderer/intake.ts packages/app/src/renderer/console.html packages/app/src/renderer/console.ts
```

- [x] **Step 5: Create the dashboard bootstrap skeleton**

`packages/app/src/renderer/dashboard.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="dashboard.js"></script>
  </body>
</html>
```

`packages/app/src/renderer/dashboard.tsx`:

```tsx
import { render } from "preact";

const root = document.getElementById("root");
if (root) render(<div>Bean Dashboard</div>, root);
```

- [x] **Step 6: Update `esbuild.config.mjs`**

```javascript
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";

const common = { bundle: true, platform: "node", format: "esm", target: "node24",
  external: ["electron"], sourcemap: true };

// Main runs as ESM (Electron 28+ supports an ESM main entry).
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });

// Preload MUST be CommonJS: Electron's sandboxed preload loader does not support
// ESM `import` statements. The package is `"type": "module"`, so a `.js` file would
// be treated as ESM — hence the `.cjs` extension.
const preloadOut = "dist/preload.cjs";
await build({ ...common, format: "cjs", entryPoints: ["src/preload.ts"], outfile: preloadOut });
const preloadSrc = readFileSync(preloadOut, "utf8");
if (/^\s*import\s/m.test(preloadSrc) || /^\s*export\s/m.test(preloadSrc)) {
  throw new Error(`${preloadOut} contains ESM syntax — Electron preload must be CommonJS`);
}

await build({ ...common, platform: "browser", jsx: "automatic", jsxImportSource: "preact",
  entryPoints: ["src/renderer/avatar.ts", "src/renderer/dashboard.tsx"],
  outdir: "dist/renderer" });

mkdirSync("dist/renderer", { recursive: true });
for (const f of ["avatar", "dashboard"]) {
  cpSync(`src/renderer/${f}.html`, `dist/renderer/${f}.html`);
}
```

- [x] **Step 7: Build and typecheck**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: both exit 0; `dist/renderer/dashboard.html` and `dist/renderer/dashboard.js` exist

- [x] **Step 8: Commit**

```bash
git add packages/app/package.json packages/app/tsconfig.json packages/app/esbuild.config.mjs packages/app/src/renderer/dashboard.html packages/app/src/renderer/dashboard.tsx
git commit -m "feat(app): add Preact, JSX config, and dashboard bootstrap; remove intake/console"
```

---

### Task 6: Theme tokens and orb CSS

**Files:**
- Create: `packages/app/src/renderer/theme.css`
- Create: `packages/app/src/renderer/orb.css`
- Modify: `packages/app/esbuild.config.mjs`

**Interfaces:**
- Produces: CSS custom properties `--bean-bg`, `--bean-surface`, `--bean-surface-2`, `--bean-border`, `--bean-text`, `--bean-text-dim`, `--bean-accent`, `--bean-accent-ink`, `--bean-orb-1/2/3`, `--bean-orb-glow`, `--bean-orb-ring`, `--bean-orb-check`, `--bean-orb-check-ink`, keyed by `[data-theme="hearth"|"graphite"]` on `<html>`. Structural classes `.bean-orb`, `.bean-orb-glow`, `.bean-orb-ring`, `.bean-orb-ring--delay`, `.bean-orb-blob`, `.bean-orb-highlight`, `.bean-orb-sheen`, `.bean-orb-check`, `.bean-orb-check-mark`, selected by `[data-state="idle"|"listening"|"working"|"done"]` on `.bean-orb`.

- [x] **Step 1: Create `theme.css`**

```css
:root[data-theme="hearth"] {
  --bean-bg: oklch(0.9 0.004 85);
  --bean-surface: oklch(0.995 0.005 75);
  --bean-surface-2: oklch(0.975 0.012 70);
  --bean-border: oklch(0.9 0.01 70);
  --bean-text: oklch(0.3 0.02 60);
  --bean-text-dim: oklch(0.55 0.015 60);
  --bean-accent: oklch(0.66 0.15 48);
  --bean-accent-ink: #fff;
  --bean-orb-1: oklch(0.85 0.12 74);
  --bean-orb-2: oklch(0.71 0.16 50);
  --bean-orb-3: oklch(0.58 0.16 32);
  --bean-orb-glow: oklch(0.74 0.15 52 / 0.5);
  --bean-orb-ring: oklch(0.72 0.14 54);
  --bean-orb-check: oklch(0.62 0.13 150 / 0.55);
  --bean-orb-check-ink: oklch(0.55 0.13 150);
}

:root[data-theme="graphite"] {
  --bean-bg: oklch(0.155 0.02 285);
  --bean-surface: oklch(0.235 0.014 265);
  --bean-surface-2: oklch(0.205 0.013 265);
  --bean-border: oklch(0.34 0.014 265);
  --bean-text: oklch(0.92 0.008 260);
  --bean-text-dim: oklch(0.62 0.02 260);
  --bean-accent: oklch(0.74 0.12 235);
  --bean-accent-ink: oklch(0.18 0.012 265);
  --bean-orb-1: oklch(0.87 0.09 215);
  --bean-orb-2: oklch(0.71 0.13 248);
  --bean-orb-3: oklch(0.52 0.15 278);
  --bean-orb-glow: oklch(0.7 0.14 240 / 0.5);
  --bean-orb-ring: oklch(0.8 0.12 232);
  --bean-orb-check: oklch(0.76 0.12 160 / 0.55);
  --bean-orb-check-ink: oklch(0.8 0.12 160);
}

html, body {
  margin: 0;
  height: 100%;
}

body {
  background: var(--bean-bg);
  color: var(--bean-text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
```

- [x] **Step 2: Create `orb.css`**

```css
@keyframes bean-orb-morph {
  0%, 100% { border-radius: 46% 54% 60% 40% / 52% 44% 56% 48%; }
  50% { border-radius: 58% 42% 40% 60% / 44% 56% 50% 54%; }
}
@keyframes bean-orb-breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
@keyframes bean-orb-breathe-fast {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
@keyframes bean-orb-spin {
  to { transform: rotate(360deg); }
}
@keyframes bean-orb-ring-out {
  0% { transform: scale(.5); opacity: .55; }
  80% { opacity: 0; }
  100% { transform: scale(1.55); opacity: 0; }
}
@keyframes bean-orb-glow-breathe {
  0%, 100% { opacity: .5; transform: scale(1); }
  50% { opacity: .85; transform: scale(1.1); }
}
@keyframes bean-orb-glow-soft {
  0%, 100% { opacity: .34; }
  50% { opacity: .52; }
}
@keyframes bean-orb-done-pulse {
  0%, 100% { opacity: .4; transform: scale(1); }
  50% { opacity: .62; transform: scale(1.07); }
}
@keyframes bean-orb-check-pop {
  0% { transform: translateY(-12%) rotate(-45deg) scale(.4); opacity: 0; }
  60% { opacity: 1; transform: translateY(-12%) rotate(-45deg) scale(1.15); }
  100% { transform: translateY(-12%) rotate(-45deg) scale(1); }
}

.bean-orb {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}

.bean-orb-glow {
  position: absolute;
  inset: -24%;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, var(--bean-orb-glow), transparent 70%);
  filter: blur(16px);
  animation: bean-orb-glow-soft 5s ease-in-out infinite;
}
.bean-orb[data-state="listening"] .bean-orb-glow,
.bean-orb[data-state="working"] .bean-orb-glow {
  animation: bean-orb-glow-breathe 3s ease-in-out infinite;
}
.bean-orb[data-state="done"] .bean-orb-glow {
  animation: bean-orb-done-pulse 2.4s ease-in-out infinite;
  background: radial-gradient(circle at 50% 50%, var(--bean-orb-check), transparent 70%);
}

.bean-orb-ring {
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  border: 1.5px solid var(--bean-orb-ring);
  opacity: 0;
  animation: bean-orb-ring-out 2.6s ease-out infinite;
}
.bean-orb-ring--delay {
  animation-delay: 1.3s;
}
.bean-orb[data-state="listening"] .bean-orb-ring {
  opacity: 1;
}

.bean-orb-blob {
  position: relative;
  width: 70%;
  height: 70%;
  border-radius: 46% 54% 60% 40%;
  background: radial-gradient(circle at 34% 28%, var(--bean-orb-1), var(--bean-orb-2) 52%, var(--bean-orb-3));
  box-shadow: 0 10px 26px -8px var(--bean-orb-glow), inset 0 -6px 14px rgba(0, 0, 0, .2);
  overflow: hidden;
  animation: bean-orb-morph 12s ease-in-out infinite, bean-orb-breathe 5.5s ease-in-out infinite;
}
.bean-orb[data-state="listening"] .bean-orb-blob {
  animation: bean-orb-morph 7s ease-in-out infinite, bean-orb-breathe 2.4s ease-in-out infinite;
}
.bean-orb[data-state="working"] .bean-orb-blob {
  animation: bean-orb-morph 6s ease-in-out infinite, bean-orb-spin 16s linear infinite, bean-orb-breathe-fast 2.4s ease-in-out infinite;
}
.bean-orb[data-state="done"] .bean-orb-blob {
  animation: bean-orb-morph 9s ease-in-out infinite;
}

.bean-orb-highlight {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(circle at 33% 27%, rgba(255, 255, 255, .65), rgba(255, 255, 255, 0) 52%);
}

.bean-orb-sheen {
  position: absolute;
  inset: -12%;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, var(--bean-orb-ring) 80deg, transparent 170deg);
  mix-blend-mode: screen;
  opacity: 0;
  animation: bean-orb-spin 3.4s linear infinite;
}
.bean-orb[data-state="working"] .bean-orb-sheen {
  opacity: .75;
}

.bean-orb-check {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
}
.bean-orb[data-state="done"] .bean-orb-check {
  opacity: 1;
}
.bean-orb-check-mark {
  width: 24%;
  height: 12%;
  border-left: 2.5px solid var(--bean-orb-check-ink);
  border-bottom: 2.5px solid var(--bean-orb-check-ink);
  border-radius: 2px;
  transform: translateY(-12%) rotate(-45deg);
  animation: bean-orb-check-pop .5s ease-out;
}
```

- [x] **Step 3: Add these two files to the esbuild copy step**

In `packages/app/esbuild.config.mjs`, add after the existing html copy loop:

```javascript
for (const f of ["theme.css", "orb.css"]) {
  cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
}
```

- [x] **Step 4: Build**

Run: `pnpm --filter @bean/app build`
Expected: exits 0; `dist/renderer/theme.css` and `dist/renderer/orb.css` exist

- [x] **Step 5: Commit**

```bash
git add packages/app/src/renderer/theme.css packages/app/src/renderer/orb.css packages/app/esbuild.config.mjs
git commit -m "feat(app): add theme token CSS and orb animation CSS"
```

---

### Task 7: Orb component

**Files:**
- Create: `packages/app/src/renderer/orb.ts`

**Interfaces:**
- Consumes: CSS classes/keyframes from `orb.css` (Task 6).
- Produces: `type OrbState = "idle" | "listening" | "working" | "done"`, `interface OrbHandle { setState(state: OrbState): void }`, `createOrb(container: HTMLElement, opts?: { size?: number }): OrbHandle`.

No automated test for this file — it's pure DOM construction with no meaningful logic to assert without a DOM environment (this repo has none, per Global Constraints). It's verified visually in Task 12.

- [x] **Step 1: Implement `orb.ts`**

```typescript
export type OrbState = "idle" | "listening" | "working" | "done";

export interface OrbHandle {
  setState(state: OrbState): void;
}

export function createOrb(container: HTMLElement, opts?: { size?: number }): OrbHandle {
  const size = opts?.size ?? 96;
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;

  const root = document.createElement("div");
  root.className = "bean-orb";
  root.dataset.state = "idle";

  const glow = document.createElement("div");
  glow.className = "bean-orb-glow";

  const ring0 = document.createElement("div");
  ring0.className = "bean-orb-ring";
  const ring1 = document.createElement("div");
  ring1.className = "bean-orb-ring bean-orb-ring--delay";

  const blob = document.createElement("div");
  blob.className = "bean-orb-blob";
  const highlight = document.createElement("div");
  highlight.className = "bean-orb-highlight";
  const sheen = document.createElement("div");
  sheen.className = "bean-orb-sheen";
  blob.append(highlight, sheen);

  const check = document.createElement("div");
  check.className = "bean-orb-check";
  const checkMark = document.createElement("div");
  checkMark.className = "bean-orb-check-mark";
  check.append(checkMark);

  root.append(glow, ring0, ring1, blob, check);
  container.replaceChildren(root);

  return {
    setState(state: OrbState) {
      root.dataset.state = state;
    },
  };
}
```

- [x] **Step 2: Typecheck**

Run: `pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: exits 0

- [x] **Step 3: Commit**

```bash
git add packages/app/src/renderer/orb.ts
git commit -m "feat(app): add shared orb component"
```

---

### Task 8: Avatar window rewrite

**Files:**
- Modify: `packages/app/src/renderer/avatar.html`
- Modify: `packages/app/src/renderer/avatar.ts`

**Interfaces:**
- Consumes: `createOrb` (Task 7), `window.bean.getTheme/onThemeChanged/openDashboard` (Task 3).

- [x] **Step 1: Update `avatar.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #bean {
        cursor: pointer;
      }
    </style>
  </head>
  <body><div id="bean" title="Bean"></div><script type="module" src="avatar.js"></script></body>
</html>
```

- [x] **Step 2: Update `avatar.ts`**

```typescript
import { createOrb } from "./orb.js";

// The window is reused for the avatar's whole lifetime now — it never navigates
// to another page — so this fixed size only needs to be set once.
window.resizeTo(120, 120);

// The window body is the drag region (so you can move the avatar around).
// The #bean element is explicitly NO-drag: a `-webkit-app-region: drag` element
// is treated by macOS as an OS window-move handle and swallows mouse events, so
// the dblclick/drop listeners must live on a no-drag element to fire at all.
(document.body.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "drag";

const el = document.getElementById("bean");
if (el) {
  (el.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "no-drag";

  const orb = createOrb(el, { size: 96 });
  orb.setState("idle");

  window.bean.getTheme().then((t) => { document.documentElement.dataset.theme = t; });
  window.bean.onThemeChanged((t) => { document.documentElement.dataset.theme = t; });

  el.addEventListener("dblclick", () => { void window.bean.openDashboard(); });

  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url) void window.bean.openDashboard(url);
  });
}
```

- [x] **Step 3: Build and typecheck**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: both exit 0

- [x] **Step 4: Commit**

```bash
git add packages/app/src/renderer/avatar.html packages/app/src/renderer/avatar.ts
git commit -m "feat(app): rewrite avatar window to use orb, theme, and dashboard IPC"
```

---

### Task 9: Dashboard shell — title bar, panel header, root app, and layout CSS

**Files:**
- Create: `packages/app/src/renderer/dashboard/Panel.tsx`
- Create: `packages/app/src/renderer/dashboard/TitleBar.tsx`
- Create: `packages/app/src/renderer/dashboard/App.tsx`
- Create: `packages/app/src/renderer/dashboard.css`
- Modify: `packages/app/src/renderer/dashboard.html`
- Modify: `packages/app/src/renderer/dashboard.tsx`
- Modify: `packages/app/esbuild.config.mjs`

**Interfaces:**
- Consumes: `createOrb`, `OrbHandle` (Task 7); `window.bean.getTheme/setTheme/onThemeChanged/onDashboardDroppedUrl` (Task 3); `Theme` (Task 1).
- Produces: `PanelHeader({ title: string })`; `TitleBar({ theme: Theme, onToggleTheme: () => void })`; `App()` (default dashboard root, renders `<CommandBarPanel droppedUrl?>`, `<ChatPanel>`, `<ConsolePanel>`, `<SkillsPanel>`, `<PersonaPanel>`, `<ProjectsPanel>` from Task 10 — those files are created in Task 10, so this task's `App.tsx` imports from paths that don't exist yet; Task 9's build/typecheck verification therefore happens after Task 10, not at the end of this task).

- [x] **Step 1: Create `Panel.tsx`**

```tsx
export function PanelHeader({ title }: { title: string }) {
  return (
    <div class="bean-panel-header">
      <span class="bean-panel-lights">
        <span class="bean-panel-light bean-panel-light--red" />
        <span class="bean-panel-light bean-panel-light--yellow" />
        <span class="bean-panel-light bean-panel-light--green" />
      </span>
      <span class="bean-panel-title">{title}</span>
    </div>
  );
}
```

- [x] **Step 2: Create `TitleBar.tsx`**

```tsx
import { useEffect, useRef } from "preact/hooks";
import { createOrb, type OrbHandle } from "../orb.js";
import type { Theme } from "../../channels.js";

export function TitleBar({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const orbRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OrbHandle | null>(null);

  useEffect(() => {
    if (orbRef.current && !handleRef.current) {
      handleRef.current = createOrb(orbRef.current, { size: 22 });
      handleRef.current.setState("idle");
    }
  }, []);

  return (
    <div class="bean-titlebar">
      <span class="bean-titlebar-dot" />
      <span class="bean-titlebar-name">Bean</span>
      <span class="bean-titlebar-menu">File</span>
      <span class="bean-titlebar-menu">View</span>
      <span class="bean-titlebar-spacer" />
      <div class="bean-titlebar-orb" ref={orbRef} />
      <span class="bean-titlebar-status">waiting</span>
      <button type="button" class="bean-theme-toggle" onClick={onToggleTheme}>
        {theme === "hearth" ? "Graphite" : "Hearth"}
      </button>
    </div>
  );
}
```

- [x] **Step 3: Create `App.tsx`**

```tsx
import { useEffect, useState } from "preact/hooks";
import { TitleBar } from "./TitleBar.js";
import { CommandBarPanel } from "./panels/CommandBarPanel.js";
import { ChatPanel } from "./panels/ChatPanel.js";
import { ConsolePanel } from "./panels/ConsolePanel.js";
import { SkillsPanel } from "./panels/SkillsPanel.js";
import { PersonaPanel } from "./panels/PersonaPanel.js";
import { ProjectsPanel } from "./panels/ProjectsPanel.js";
import type { Theme } from "../../channels.js";

export function App() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(
    new URLSearchParams(window.location.search).get("droppedUrl") ?? undefined,
  );

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.onDashboardDroppedUrl(setDroppedUrl);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = (): void => {
    const next: Theme = theme === "hearth" ? "graphite" : "hearth";
    void window.bean.setTheme(next);
  };

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={toggleTheme} />
      <div class="bean-dashboard-grid">
        <CommandBarPanel droppedUrl={droppedUrl} />
        <ChatPanel />
        <ConsolePanel />
        <SkillsPanel />
        <PersonaPanel />
        <ProjectsPanel />
      </div>
    </div>
  );
}
```

- [x] **Step 4: Create `dashboard.css`**

```css
.bean-dashboard {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.bean-titlebar {
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--bean-surface-2);
  border-bottom: 1px solid var(--bean-border);
  font-size: 12.5px;
  color: var(--bean-text-dim);
}
.bean-titlebar-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--bean-accent);
}
.bean-titlebar-name {
  font-weight: 700;
  color: var(--bean-text);
}
.bean-titlebar-spacer {
  flex: 1;
}
.bean-titlebar-orb {
  width: 22px;
  height: 22px;
}
.bean-theme-toggle {
  font: 600 11px ui-monospace, monospace;
  color: var(--bean-text);
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 7px;
  padding: 4px 8px;
  cursor: pointer;
}

.bean-dashboard-grid {
  flex: 1;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding: 24px;
}

.bean-panel {
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 220px;
}
.bean-panel--wide {
  grid-column: 1 / 3;
}

.bean-panel-header {
  height: 38px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: var(--bean-surface-2);
  border-bottom: 1px solid var(--bean-border);
  position: relative;
}
.bean-panel-lights {
  display: flex;
  gap: 7px;
  flex: none;
}
.bean-panel-light {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  display: block;
}
.bean-panel-light--red { background: #ff5f57; }
.bean-panel-light--yellow { background: #febc2e; }
.bean-panel-light--green { background: #28c840; }
.bean-panel-title {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--bean-text-dim);
  pointer-events: none;
}

.bean-panel-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  font-size: 13px;
  color: var(--bean-text-dim);
  text-align: center;
}
.bean-panel-dropped-url {
  margin-top: 8px;
  font: 12px ui-monospace, monospace;
  color: var(--bean-accent);
  word-break: break-all;
}
```

- [x] **Step 5: Update `dashboard.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="dashboard.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="dashboard.js"></script>
  </body>
</html>
```

- [x] **Step 6: Update `dashboard.tsx`**

```tsx
import { render } from "preact";
import { App } from "./dashboard/App.js";

const root = document.getElementById("root");
if (root) render(<App />, root);
```

- [x] **Step 7: Add `dashboard.css` to the esbuild copy step**

In `packages/app/esbuild.config.mjs`, change the CSS copy loop from Task 6 to:

```javascript
for (const f of ["theme.css", "orb.css", "dashboard.css"]) {
  cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
}
```

- [x] **Step 8: Commit**

Do not build or typecheck yet — `App.tsx` imports the six panel files created in Task 10. Commit this task's files now; Task 10 will run the build/typecheck gate for both tasks together.

```bash
git add packages/app/src/renderer/dashboard packages/app/src/renderer/dashboard.css packages/app/src/renderer/dashboard.html packages/app/src/renderer/dashboard.tsx packages/app/esbuild.config.mjs
git commit -m "feat(app): add dashboard shell (title bar, panel header, layout CSS)"
```

---

### Task 10: The six panel placeholders

**Files:**
- Create: `packages/app/src/renderer/dashboard/panels/CommandBarPanel.tsx`
- Create: `packages/app/src/renderer/dashboard/panels/ChatPanel.tsx`
- Create: `packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx`
- Create: `packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx`
- Create: `packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx`
- Create: `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`

**Interfaces:**
- Consumes: `PanelHeader` (Task 9).
- Produces: `CommandBarPanel({ droppedUrl?: string })`, `ChatPanel()`, `ConsolePanel()`, `SkillsPanel()`, `PersonaPanel()`, `ProjectsPanel()` — each a self-contained component sub-project 2–6 will replace the body of, one file at a time.

- [x] **Step 1: Create `CommandBarPanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function CommandBarPanel({ droppedUrl }: { droppedUrl?: string }) {
  return (
    <div class="bean-panel bean-panel--wide">
      <PanelHeader title="Command Bar" />
      <div class="bean-panel-empty">
        <div>
          Command bar is coming in a later build.
          {droppedUrl ? <div class="bean-panel-dropped-url">{droppedUrl}</div> : null}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Create `ChatPanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function ChatPanel() {
  return (
    <div class="bean-panel">
      <PanelHeader title="Chat" />
      <div class="bean-panel-empty">Chat is coming in a later build.</div>
    </div>
  );
}
```

- [x] **Step 3: Create `ConsolePanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function ConsolePanel() {
  return (
    <div class="bean-panel">
      <PanelHeader title="opencode · run" />
      <div class="bean-panel-empty">Console output is coming in a later build.</div>
    </div>
  );
}
```

- [x] **Step 4: Create `SkillsPanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function SkillsPanel() {
  return (
    <div class="bean-panel">
      <PanelHeader title="Skills" />
      <div class="bean-panel-empty">Skills browsing is coming in a later build.</div>
    </div>
  );
}
```

- [x] **Step 5: Create `PersonaPanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function PersonaPanel() {
  return (
    <div class="bean-panel">
      <PanelHeader title="Persona" />
      <div class="bean-panel-empty">Persona settings are coming in a later build.</div>
    </div>
  );
}
```

- [x] **Step 6: Create `ProjectsPanel.tsx`**

```tsx
import { PanelHeader } from "../Panel.js";

export function ProjectsPanel() {
  return (
    <div class="bean-panel bean-panel--wide">
      <PanelHeader title="Projects & Tasks" />
      <div class="bean-panel-empty">Projects and launch controls are coming in a later build.</div>
    </div>
  );
}
```

- [x] **Step 7: Build and typecheck (covers Task 9 and Task 10 together)**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit`
Expected: both exit 0; `dist/renderer/dashboard.js` and `dist/renderer/dashboard.css` exist

- [x] **Step 8: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels
git commit -m "feat(app): add the six dashboard panel placeholders"
```

---

### Task 11: Update the window-behavior safety memory entry

**Files:**
- Modify: `.memory/safety-window-behavior.md`

- [x] **Step 1: Rewrite the entry to reflect the new window model**

```markdown
# safety: renderer window behavior — reuse, sizing, drag, lifecycle

The Electron windowing has several non-obvious behaviors. Don't "fix" them away.

**The avatar window never navigates.** Unlike the old avatar+intake single-window model,
`avatar.html` is loaded once and stays loaded for the app's lifetime. Double-click/drop
call `window.bean.openDashboard(droppedUrl?)` (IPC), which opens or focuses a *separate*
`dashboard` `BrowserWindow` — it does not `location.href` the avatar window anywhere.

**The avatar must stay no-drag where you click.** The avatar window body is a
`-webkit-app-region: drag` region so you can move the pet around. macOS treats a drag
region as an OS window-move handle and **swallows mouse events**, so the clickable
`#bean` element must be `-webkit-app-region: no-drag` or its `dblclick`/`drop` listeners
never fire. This broke before — keep the click target no-drag.

**The dashboard window does not respawn on close.** Unlike the old console window,
closing the dashboard just clears `main.ts`'s in-memory reference; a later
`openDashboard()` call creates a fresh one. There is intentionally no dashboard-window
equivalent of the old console auto-respawn.

**Closing the avatar does not quit the app** (macOS-style); the app only quits on
`window-all-closed` off-darwin. Intentional.

**Theme state lives in `main.ts`, not per-window.** `getCurrentTheme`/`setCurrentTheme`
are closures over a single `currentTheme` variable in `main.ts`; every window's theme
follows the same `bean:theme-changed` broadcast. Don't give a window its own local theme
state — it'll drift from the others.
```

- [x] **Step 2: Commit**

```bash
git add .memory/safety-window-behavior.md
git commit -m "docs(memory): update window-behavior safety entry for dashboard model"
```

---

### Task 12: Manual verification and final gate

**Files:** none (verification only)

- [x] **Step 1: Run the full validation gate**

Run: `pnpm test && pnpm typecheck` (from the repo root)
Expected: both exit 0 across all packages

- [x] **Step 2: Manually verify in the running app**

Run: `pnpm dev`

Check each of the following and note what you actually observed (per this project's convention of verifying UI changes by running the app, not just trusting green tests):
- The avatar window appears at its usual small size, transparent background, and shows the orb in its resting (`idle`) animation.
- Dragging the avatar window by its background still moves it (the no-drag click target didn't regress).
- Double-clicking the avatar opens the dashboard window.
- Double-clicking the avatar again while the dashboard is already open focuses the existing window rather than opening a second one.
- Dragging a URL onto the avatar opens the dashboard with that URL visible in the Command Bar panel's placeholder text.
- The dashboard shows the title bar (with its own small orb, "waiting" status, and theme toggle button) and the 2-column grid with all six panels (Command Bar and Projects & Tasks spanning both columns).
- Clicking the theme toggle switches both the dashboard's own colors and the avatar window's orb palette together (open both at once to check) — and the choice persists across an app restart.
- Quitting and relaunching `pnpm dev` restores the last-selected theme.

- [x] **Step 3: Fix anything observed above that doesn't match, then re-run Steps 1–2**

- [ ] **Step 4: Final commit (only if Step 2 required fixes not yet committed)**

```bash
git add -A
git commit -m "fix(app): address manual verification findings for dashboard foundation"
```
