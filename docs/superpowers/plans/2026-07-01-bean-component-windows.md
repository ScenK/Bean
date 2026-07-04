# Bean — Bubble Menu + Per-Component Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the single flat `dashboard` window. Double-clicking the bean opens a bubble
menu (Chat / Skills / Persona / Projects); picking a bubble opens/focuses that component's own
dedicated window. Renderer code is restructured from flat `renderer/dashboard/panels/*` into
`renderer/components/<name>/*` + `renderer/shared/*`.

**Architecture:** One singleton `BrowserWindow` per component (`chat`/`skills`/`persona`/
`projects`), keyed in a `Map` in `main.ts`, replacing today's single `dashboardWin`. The avatar
window temporarily grows via `setBounds` (pure bounds math in a new testable module) to show 4
bubble buttons; picking one calls a new `IPC.openComponent` channel. `bean:run-event`/
`bean:task-event` are re-routed to target the Chat/Projects windows specifically instead of one
hardcoded sender.

**Tech Stack:** Electron, Preact + esbuild (unchanged), TypeScript strict, Vitest.

## Global Constraints

- `@bean/core` stays pure and Electron-free — this plan makes no core changes at all.
- IPC channel names live only in `packages/app/src/channels.ts`, referenced via `IPC.*`.
- Electron preload stays CommonJS `.cjs` (existing esbuild ESM-syntax guard, untouched).
- No new dependencies.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0 — **but this
  only needs to pass at Task 10.** Tasks 2–9 intentionally leave the `@bean/app` package in a
  non-compiling intermediate state (old symbols like `openDashboard` are removed from the IPC
  contract in Task 2 before every consumer is migrated off them in Tasks 3–9) — this is the same
  "deferred gate" pattern this repo's SP3/SP4 already used. Each task's own verification step
  says exactly what to run and expect; do not try to "fix" the whole package's typecheck before
  Task 10.
- Do not touch panel *behavior* (Chat's proposal flow, Skills' edit flow, Persona's tag editor,
  Projects' launcher/task monitor) — only how files are organized and how windows are opened.

---

### Task 1: Avatar menu bounds math (pure, testable)

**Files:**
- Create: `packages/app/src/avatar-menu.ts`
- Test: `packages/app/__test__/avatar-menu.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AVATAR_SIZE: number`, `AVATAR_MENU_SIZE: number`, `Bounds` interface
  (`{ x: number; y: number; width: number; height: number }`), `nextAvatarBounds(current: Bounds,
  open: boolean): Bounds` — used by Task 3 (`ipc.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/__test__/avatar-menu.test.ts
import { expect, test } from "vitest";
import { AVATAR_MENU_SIZE, AVATAR_SIZE, nextAvatarBounds } from "../src/avatar-menu.js";

test("opening the menu grows the window, centered on its current position", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE, height: AVATAR_SIZE };
  const opened = nextAvatarBounds(closed, true);
  expect(opened).toEqual({ x: 10, y: 10, width: AVATAR_MENU_SIZE, height: AVATAR_MENU_SIZE });
});

test("closing the menu shrinks the window back to its exact original bounds", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE, height: AVATAR_SIZE };
  const opened = nextAvatarBounds(closed, true);
  const reClosed = nextAvatarBounds(opened, false);
  expect(reClosed).toEqual(closed);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run avatar-menu`
Expected: FAIL — `Cannot find module '../src/avatar-menu.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/app/src/avatar-menu.ts
export const AVATAR_SIZE = 120;
export const AVATAR_MENU_SIZE = 300;
const INSET = (AVATAR_MENU_SIZE - AVATAR_SIZE) / 2;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the avatar window's next bounds when the bubble menu opens or closes.
 * Grows/shrinks the window symmetrically around its current center so the bean
 * itself doesn't visually jump when the menu appears.
 */
export function nextAvatarBounds(current: Bounds, open: boolean): Bounds {
  const delta = open ? INSET : -INSET;
  const size = open ? AVATAR_MENU_SIZE : AVATAR_SIZE;
  return { x: current.x - delta, y: current.y - delta, width: size, height: size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run avatar-menu`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/avatar-menu.ts packages/app/__test__/avatar-menu.test.ts
git commit -m "feat(app): add pure avatar bubble-menu bounds math"
```

---

### Task 2: IPC contract — channels, preload, bean.d.ts, ipc.ts

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `nextAvatarBounds` from Task 1.
- Produces: `ComponentKind` type; `IPC.openComponent`, `IPC.componentDroppedUrl`,
  `IPC.proposeRun`, `IPC.setAvatarMenuOpen` channel names; `window.bean.openComponent(kind,
  droppedUrl?)`, `window.bean.onComponentDroppedUrl(cb)`, `window.bean.proposeRun(suggestion)`,
  `window.bean.onProposeRun(cb)`, `window.bean.setAvatarMenuOpen(open)`; `RegisterDeps.chatSender`
  / `.projectsSender` / `.openComponent` / `.proposeRun` (replacing `.sender` /
  `.openDashboard`), consumed by Task 3 (`main.ts`). `IPC.openDashboard`/`dashboardDroppedUrl`
  and `window.bean.openDashboard`/`onDashboardDroppedUrl` are removed.

- [ ] **Step 1: Update `channels.ts`**

```ts
// packages/app/src/channels.ts
export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects";

export const IPC = {
  route: "bean:route",
  run: "bean:run",
  chat: "bean:chat",
  listSkills: "bean:list-skills",
  listProjects: "bean:list-projects",
  saveSkill: "bean:save-skill",
  launchTask: "bean:launch-task",
  cancelTask: "bean:cancel-task",
  taskEvent: "bean:task-event",
  getPersona: "bean:get-persona",
  savePersona: "bean:save-persona",
  runEvent: "bean:run-event",
  getTheme: "bean:get-theme",
  setTheme: "bean:set-theme",
  themeChanged: "bean:theme-changed",
  openComponent: "bean:open-component",
  componentDroppedUrl: "bean:component-dropped-url",
  proposeRun: "bean:propose-run",
  moveWindowBy: "bean:move-window-by",
  setAvatarMenuOpen: "bean:set-avatar-menu-open",
} as const;
```

- [ ] **Step 2: Update `preload.ts`**

```ts
// packages/app/src/preload.ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import type {
  RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona,
  LaunchRequest, TaskEvent,
} from "@bean/core";

contextBridge.exposeInMainWorld("bean", {
  route: (input: RouteInput): Promise<RouteSuggestion> => ipcRenderer.invoke(IPC.route, input),
  run: (s: RouteSuggestion): Promise<string> => ipcRenderer.invoke(IPC.run, s),
  chat: (req: ChatRequest): Promise<ConverseResult> => ipcRenderer.invoke(IPC.chat, req),
  onRunEvent: (cb: (e: RunEvent) => void) =>
    ipcRenderer.on(IPC.runEvent, (_e, ev: RunEvent) => cb(ev)),
  getTheme: (): Promise<Theme> => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (t: Theme): Promise<void> => ipcRenderer.invoke(IPC.setTheme, t),
  onThemeChanged: (cb: (t: Theme) => void) =>
    ipcRenderer.on(IPC.themeChanged, (_e, t: Theme) => cb(t)),
  openComponent: (kind: ComponentKind, droppedUrl?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.openComponent, kind, droppedUrl),
  onComponentDroppedUrl: (cb: (url: string) => void) =>
    ipcRenderer.on(IPC.componentDroppedUrl, (_e, url: string) => cb(url)),
  proposeRun: (suggestion: RouteSuggestion): void => ipcRenderer.send(IPC.proposeRun, suggestion),
  onProposeRun: (cb: (suggestion: RouteSuggestion) => void) =>
    ipcRenderer.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => cb(suggestion)),
  moveWindowBy: (dx: number, dy: number): void => ipcRenderer.send(IPC.moveWindowBy, dx, dy),
  setAvatarMenuOpen: (open: boolean): void => ipcRenderer.send(IPC.setAvatarMenuOpen, open),
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC.listSkills),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.listProjects),
  saveSkill: (name: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.saveSkill, name, body),
  getPersona: (): Promise<Persona> => ipcRenderer.invoke(IPC.getPersona),
  savePersona: (p: Persona): Promise<void> => ipcRenderer.invoke(IPC.savePersona, p),
  launchTask: (taskId: string, req: LaunchRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.launchTask, taskId, req),
  cancelTask: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.cancelTask, taskId),
  onTaskEvent: (cb: (e: TaskEvent) => void) =>
    ipcRenderer.on(IPC.taskEvent, (_e, ev: TaskEvent) => cb(ev)),
});
```

- [ ] **Step 3: Update `bean.d.ts`**

```ts
// packages/app/src/renderer/bean.d.ts
import type {
  RouteInput, RouteSuggestion, RunEvent, ChatRequest, ConverseResult, Skill, Project, Persona,
  LaunchRequest, TaskEvent,
} from "@bean/core";
import type { Theme, ComponentKind } from "../channels.js";

declare global {
  interface Window {
    bean: {
      route(input: RouteInput): Promise<RouteSuggestion>;
      run(s: RouteSuggestion): Promise<string>;
      chat(req: ChatRequest): Promise<ConverseResult>;
      onRunEvent(cb: (e: RunEvent) => void): void;
      getTheme(): Promise<Theme>;
      setTheme(t: Theme): Promise<void>;
      onThemeChanged(cb: (t: Theme) => void): void;
      openComponent(kind: ComponentKind, droppedUrl?: string): Promise<void>;
      onComponentDroppedUrl(cb: (url: string) => void): void;
      proposeRun(suggestion: RouteSuggestion): void;
      onProposeRun(cb: (suggestion: RouteSuggestion) => void): void;
      moveWindowBy(dx: number, dy: number): void;
      setAvatarMenuOpen(open: boolean): void;
      listSkills(): Promise<Skill[]>;
      listProjects(): Promise<Project[]>;
      saveSkill(name: string, body: string): Promise<void>;
      getPersona(): Promise<Persona>;
      savePersona(p: Persona): Promise<void>;
      launchTask(taskId: string, req: LaunchRequest): Promise<void>;
      cancelTask(taskId: string): Promise<void>;
      onTaskEvent(cb: (e: TaskEvent) => void): void;
    };
  }
}

export {};
```

- [ ] **Step 4: Update `ipc.ts`**

Replace the `LaunchHandlerDeps`/`buildLaunchHandlers` `sender` field with `projectsSender`:

```ts
export interface LaunchHandlerDeps {
  projectsSender: () => WebContents | undefined;
  spawnLaunch?: LaunchSpawnFn;
}

export function buildLaunchHandlers(deps: LaunchHandlerDeps) {
  const tasks = new Map<string, LaunchHandle>();
  return {
    launch: (taskId: string, req: LaunchRequest): void => {
      const handle = launchTask(
        taskId,
        req,
        (ev) => {
          deps.projectsSender()?.send(IPC.taskEvent, ev);
          if (ev.status !== "running") tasks.delete(taskId);
        },
        deps.spawnLaunch,
      );
      tasks.set(taskId, handle);
    },
    cancel: (taskId: string): void => { tasks.get(taskId)?.cancel(); },
  };
}
```

Update the import line to bring in `BrowserWindow` and `nextAvatarBounds`, and `ComponentKind`:

```ts
import {
  route, runOpencode, converse, launchTask,
  type Project, type RouteInput, type RouteSuggestion, type Skill,
  type ConverseDeps, type ConverseResult, type ChatRequest, type Persona,
  type LaunchRequest, type LaunchHandle, type LaunchSpawnFn,
} from "@bean/core";
import type { RouterDeps } from "@bean/core";
import { BrowserWindow, type IpcMain, type WebContents } from "electron";
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import { nextAvatarBounds } from "./avatar-menu.js";
```

Replace `RegisterDeps` and the tail of `registerIpc`:

```ts
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  converse: ConverseDeps["chat"];
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  loadPersona: (file: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  chatSender: () => WebContents | undefined;
  projectsSender: () => WebContents | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  spawnLaunch?: LaunchSpawnFn;
}

export function registerIpc(ipcMain: IpcMain, deps: RegisterDeps): void {
  const routeHandler = buildRouteHandler(deps);
  ipcMain.handle(IPC.route, (_e, input: RouteInput) => routeHandler(input));
  ipcMain.handle(IPC.run, async (_e, suggestion: RouteSuggestion) =>
    runOpencode(suggestion, (event) => deps.chatSender()?.send(IPC.runEvent, event)),
  );

  const chatHandler = buildChatHandler(deps);
  ipcMain.handle(IPC.chat, (_e, req: ChatRequest) => chatHandler(req));

  const listSkillsHandler = buildListSkillsHandler(deps);
  ipcMain.handle(IPC.listSkills, () => listSkillsHandler());

  const listProjectsHandler = buildListProjectsHandler(deps);
  ipcMain.handle(IPC.listProjects, () => listProjectsHandler());

  const saveSkillHandler = buildSaveSkillHandler(deps);
  ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) => saveSkillHandler(name, body));

  const launchHandlers = buildLaunchHandlers(deps);
  ipcMain.handle(IPC.launchTask, (_e, taskId: string, req: LaunchRequest) => launchHandlers.launch(taskId, req));
  ipcMain.handle(IPC.cancelTask, (_e, taskId: string) => launchHandlers.cancel(taskId));

  const personaHandlers = buildPersonaHandlers(deps);
  ipcMain.handle(IPC.getPersona, () => personaHandlers.get());
  ipcMain.handle(IPC.savePersona, (_e, p: Persona) => personaHandlers.save(p));

  const theme = buildThemeHandlers(deps);
  ipcMain.handle(IPC.getTheme, () => theme.get());
  ipcMain.handle(IPC.setTheme, async (_e, next: Theme) => {
    await theme.set(next);
    deps.broadcast(IPC.themeChanged, next);
  });

  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, droppedUrl?: string) => deps.openComponent(kind, droppedUrl));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));

  // Manual drag-to-move for the avatar: the visible #bean element is deliberately
  // -webkit-app-region: no-drag (see .memory/safety-window-behavior.md), so moving
  // it is done via mouse deltas from the renderer instead of the CSS drag region.
  ipcMain.on(IPC.moveWindowBy, (e, dx: number, dy: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const [x = 0, y = 0] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  });

  // Bubble menu: grows/shrinks the avatar window around its current position.
  let avatarMenuOpen = false;
  ipcMain.on(IPC.setAvatarMenuOpen, (e, open: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || open === avatarMenuOpen) return;
    avatarMenuOpen = open;
    win.setBounds(nextAvatarBounds(win.getBounds(), open));
  });
}
```

- [ ] **Step 5: Update `ipc.test.ts`'s launch-handler tests**

In `packages/app/__test__/ipc.test.ts`, rename every `sender:` field to `projectsSender:` in the
three `buildLaunchHandlers({...})` call sites (the "launch handler...", "cancel handler...", and
"task map entry..." tests) — same value, just the renamed key. No other change in that file.

- [ ] **Step 6: Verify what's checkable at this point**

Run: `pnpm --filter @bean/app exec vitest run`
Expected: PASS — `ipc.test.ts`, `theme-store.test.ts`, and `avatar-menu.test.ts` (from Task 1)
all green. (Do NOT run `pnpm typecheck` yet — `main.ts`, `avatar.ts`, and the old
`dashboard.tsx`/`App.tsx` still reference removed symbols like `openDashboard` and `.sender`;
this is expected per the Global Constraints deferred-gate note and is fixed by Task 3 onward.)

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/preload.ts \
  packages/app/src/renderer/bean.d.ts packages/app/src/ipc.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): replace openDashboard IPC with per-component openComponent/proposeRun"
```

---

### Task 3: `windows.ts` + `main.ts` — component window map

**Files:**
- Modify: `packages/app/src/windows.ts`
- Modify: `packages/app/src/main.ts`

**Interfaces:**
- Consumes: `ComponentKind` (Task 2), `RegisterDeps` shape (Task 2).
- Produces: `createComponentWindow(kind: ComponentKind): BrowserWindow` (replaces
  `createDashboardWindow`) — not consumed elsewhere in this plan beyond `main.ts` itself.

- [ ] **Step 1: Update `windows.ts`**

```ts
// packages/app/src/windows.ts
import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ComponentKind } from "./channels.js";

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

export function createComponentWindow(kind: ComponentKind): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040, height: 720,
    webPreferences: { preload },
  });
  void win.loadFile(renderer(kind));
  return win;
}
```

- [ ] **Step 2: Update `main.ts`**

```ts
// packages/app/src/main.ts
import { app, ipcMain, dialog, BrowserWindow, nativeTheme } from "electron";
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile,
  loadConfig, loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
  makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
import type { RouteSuggestion } from "@bean/core";
import { createAvatarWindow, createComponentWindow } from "./windows.js";
import { registerIpc } from "./ipc.js";
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import { saveTheme, themeFile } from "./theme-store.js";

function sendWhenReady(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", () => win.webContents.send(channel, payload));
  } else {
    win.webContents.send(channel, payload);
  }
}

app.whenReady().then(async () => {
  const dir = beanDir();
  const avatar = createAvatarWindow();
  avatar.on("closed", () => { /* keep app */ });

  const componentWindows = new Map<ComponentKind, BrowserWindow>();
  const openComponent = (kind: ComponentKind, droppedUrl?: string): void => {
    const existing = componentWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      if (droppedUrl && kind === "chat") existing.webContents.send(IPC.componentDroppedUrl, droppedUrl);
      return;
    }
    const win = createComponentWindow(kind);
    componentWindows.set(kind, win);
    win.on("closed", () => { componentWindows.delete(kind); });
    if (droppedUrl && kind === "chat") sendWhenReady(win, IPC.componentDroppedUrl, droppedUrl);
  };
  const proposeRun = (suggestion: RouteSuggestion): void => {
    openComponent("chat");
    sendWhenReady(componentWindows.get("chat")!, IPC.proposeRun, suggestion);
  };

  const themePath = themeFile(app.getPath("userData"));
  const systemTheme = (): Theme => (nativeTheme.shouldUseDarkColors ? "graphite" : "hearth");
  let currentTheme: Theme = systemTheme();
  const getCurrentTheme = (): Theme => currentTheme;
  const setCurrentTheme = async (theme: Theme): Promise<void> => {
    currentTheme = theme;
    await saveTheme(themePath, theme);
  };
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };

  nativeTheme.on("updated", () => {
    const next = systemTheme();
    if (next === currentTheme) return;
    currentTheme = next;
    broadcast(IPC.themeChanged, next);
  });

  try {
    const cfg = await loadConfig(configFile(dir), dir);
    if (cfg.openaiApiKey === "") {
      dialog.showErrorBox("Bean", "Missing openaiApiKey in ~/.bean/config.json");
    }
    registerIpc(ipcMain, {
      loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
      chat: makeOpenAIChat(cfg.openaiApiKey),
      converse: makeOpenAIConverse(cfg.openaiApiKey),
      model: cfg.model,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      chatSender: () => componentWindows.get("chat")?.webContents,
      projectsSender: () => componentWindows.get("projects")?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun,
    });
  } catch (err) {
    dialog.showErrorBox("Bean", err instanceof Error ? err.message : String(err));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 3: Verify what's checkable at this point**

Run: `pnpm --filter @bean/app exec vitest run`
Expected: PASS (no test touches `main.ts`/`windows.ts` directly). Typecheck is still expected to
fail overall (renderer files not migrated yet) — do not attempt to fix that now.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/windows.ts packages/app/src/main.ts
git commit -m "feat(app): replace single dashboard window with per-component window map"
```

---

### Task 4: Renderer `shared/` folder

**Files:**
- Create: `packages/app/src/renderer/shared/TitleBar.tsx` (from `dashboard/TitleBar.tsx`, plus a
  default value)
- Create: `packages/app/src/renderer/shared/Panel.tsx` (from `dashboard/Panel.tsx`, unchanged)
- Create: `packages/app/src/renderer/shared/ProposalCard.tsx` (from `dashboard/ProposalCard.tsx`, unchanged)
- Create: `packages/app/src/renderer/shared/chat-types.ts` (from `dashboard/chat-types.ts`, unchanged)
- Create: `packages/app/src/renderer/shared/task-types.ts` (from `dashboard/task-types.ts`, unchanged)
- Create: `packages/app/src/renderer/shared/format.ts` (from `dashboard/format.ts`, unchanged)
- Delete: `packages/app/src/renderer/dashboard/TitleBar.tsx`, `Panel.tsx`, `ProposalCard.tsx`,
  `chat-types.ts`, `task-types.ts`, `format.ts` (the old `dashboard/panels/*.tsx` and
  `dashboard/App.tsx` are handled in Tasks 5–8, not here)

**Interfaces:**
- Consumes: nothing new.
- Produces: same exports as before (`PanelHeader`, `TitleBar`, `ProposalCard`, `ChatItem`/
  `newId`, `TaskCard`/`LAUNCH_MODE_LABEL`, `formatElapsed`) from their new `shared/` paths —
  consumed by Tasks 5–8. Both `dashboard/Panel.tsx` and `shared/Panel.tsx` sit one directory
  level under `renderer/`, and `dashboard/TitleBar.tsx`'s only relative imports
  (`../orb.js`, `../../channels.js`) resolve identically from `shared/`, so these are pure file
  moves except one prop default added to `TitleBar`.

- [ ] **Step 1: Move the 5 side-effect-free files verbatim**

```bash
mkdir -p packages/app/src/renderer/shared
git mv packages/app/src/renderer/dashboard/Panel.tsx packages/app/src/renderer/shared/Panel.tsx
git mv packages/app/src/renderer/dashboard/ProposalCard.tsx packages/app/src/renderer/shared/ProposalCard.tsx
git mv packages/app/src/renderer/dashboard/chat-types.ts packages/app/src/renderer/shared/chat-types.ts
git mv packages/app/src/renderer/dashboard/task-types.ts packages/app/src/renderer/shared/task-types.ts
git mv packages/app/src/renderer/dashboard/format.ts packages/app/src/renderer/shared/format.ts
```

- [ ] **Step 2: Move `TitleBar.tsx` and add an `activity` default**

```bash
git mv packages/app/src/renderer/dashboard/TitleBar.tsx packages/app/src/renderer/shared/TitleBar.tsx
```

Edit `packages/app/src/renderer/shared/TitleBar.tsx` — change the props destructure so
non-Chat windows (which have no run activity) don't have to pass one:

```tsx
export function TitleBar({
  theme,
  onToggleTheme,
  activity = "idle",
}: {
  theme: Theme;
  onToggleTheme: () => void;
  activity?: OrbState;
}) {
```
(everything else in the file — imports, the returned JSX — is unchanged.)

- [ ] **Step 3: Verify**

Run: `ls packages/app/src/renderer/dashboard/` — should now show only `App.tsx` and `panels/`
(handled in later tasks) and `TaskMonitor.tsx` (moves in Task 8).

No automated test for this step (pure relocation); the overall package typecheck is still
expected to fail (nothing consumes `shared/*` yet, and the old `dashboard/panels/*` still import
the now-deleted `../Panel.js` etc. — fixed as each panel migrates in Tasks 5–8).

- [ ] **Step 4: Commit**

```bash
git add -A packages/app/src/renderer/shared packages/app/src/renderer/dashboard
git commit -m "refactor(app): extract renderer/shared from renderer/dashboard"
```

---

### Task 5: Chat window

**Files:**
- Create: `packages/app/src/renderer/components/chat/index.tsx`
- Create: `packages/app/src/renderer/components/chat/ChatWindow.tsx`
- Create: `packages/app/src/renderer/components/chat/ChatPanel.tsx` (from
  `dashboard/panels/ChatPanel.tsx`, import paths updated)
- Create: `packages/app/src/renderer/components/chat/CommandBarPanel.tsx` (from
  `dashboard/panels/CommandBarPanel.tsx`, import paths updated + drop `bean-panel--wide`)
- Create: `packages/app/src/renderer/components/chat/ConsolePanel.tsx` (from
  `dashboard/panels/ConsolePanel.tsx`, import paths updated)
- Create: `packages/app/src/renderer/chat.html`
- Delete: `packages/app/src/renderer/dashboard/panels/ChatPanel.tsx`,
  `CommandBarPanel.tsx`, `ConsolePanel.tsx`

**Interfaces:**
- Consumes: `TitleBar`, `Panel`(`PanelHeader`), `ProposalCard`, `ChatItem`/`newId` from
  `../../shared/*` (Task 4); `window.bean.onComponentDroppedUrl`, `.onProposeRun`, `.onRunEvent`,
  `.chat`, `.run`, `.setTheme`, `.getTheme`, `.onThemeChanged` (Task 2).
- Produces: `ChatWindow` component (self-contained, no props) — mounted by `index.tsx`; nothing
  else in this plan imports from `components/chat/*`.

- [ ] **Step 1: Move and fix up the 3 panel files**

```bash
mkdir -p packages/app/src/renderer/components/chat
git mv packages/app/src/renderer/dashboard/panels/ChatPanel.tsx packages/app/src/renderer/components/chat/ChatPanel.tsx
git mv packages/app/src/renderer/dashboard/panels/CommandBarPanel.tsx packages/app/src/renderer/components/chat/CommandBarPanel.tsx
git mv packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx packages/app/src/renderer/components/chat/ConsolePanel.tsx
```

In `ChatPanel.tsx`, change the import lines from:
```tsx
import { PanelHeader } from "../Panel.js";
import { ProposalCard } from "../ProposalCard.js";
import type { ChatItem } from "../chat-types.js";
```
to:
```tsx
import { PanelHeader } from "../../shared/Panel.js";
import { ProposalCard } from "../../shared/ProposalCard.js";
import type { ChatItem } from "../../shared/chat-types.js";
```

In `ConsolePanel.tsx`, change:
```tsx
import { PanelHeader } from "../Panel.js";
import { formatElapsed } from "../format.js";
```
to:
```tsx
import { PanelHeader } from "../../shared/Panel.js";
import { formatElapsed } from "../../shared/format.js";
```

In `CommandBarPanel.tsx`, change:
```tsx
import { PanelHeader } from "../Panel.js";
```
to:
```tsx
import { PanelHeader } from "../../shared/Panel.js";
```
and change the returned root `<div>`'s class from `"bean-panel bean-panel--wide"` to
`"bean-panel"` (the grid `--wide` modifier no longer applies — this window has no grid).

- [ ] **Step 2: Write `ChatWindow.tsx`**

```tsx
// packages/app/src/renderer/components/chat/ChatWindow.tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { TitleBar } from "../../shared/TitleBar.js";
import { CommandBarPanel } from "./CommandBarPanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { ConsolePanel } from "./ConsolePanel.js";
import { newId, type ChatItem } from "../../shared/chat-types.js";
import type { Theme } from "../../../channels.js";
import { appendChunk, emptyTerminal, type TerminalState } from "@bean/core/terminal";
import type { ChatTurn, RouteSuggestion, RunEvent } from "@bean/core";
import type { OrbState } from "../../orb.js";

export function ChatWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [droppedUrl, setDroppedUrl] = useState<string | undefined>(
    new URLSearchParams(window.location.search).get("droppedUrl") ?? undefined,
  );
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<OrbState>("idle");
  const [currentRun, setCurrentRun] = useState<{ skillName: string; projectPath: string; prompt: string } | undefined>(undefined);
  const [terminal, setTerminal] = useState<TerminalState>(() => emptyTerminal());
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.onComponentDroppedUrl(setDroppedUrl);
    window.bean.onProposeRun((run: RouteSuggestion) => {
      setItems((prev) => [...prev, { kind: "proposal", id: newId(), run, state: "pending" }]);
    });
    window.bean.onRunEvent((ev: RunEvent) => {
      if (ev.type === "stdout") {
        setTerminal((s) => appendChunk(s, ev.text, "stdout"));
        return;
      }
      if (ev.type === "stderr") {
        setTerminal((s) => appendChunk(s, ev.text, "stderr"));
        return;
      }
      if (ev.status === "running") {
        setTerminal(emptyTerminal());
        setRunStatus("running");
        setStartedAt(Date.now());
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Spinning up…", tone: "info" }]);
        setActivity("working");
      } else if (ev.status === "done") {
        setRunStatus("done");
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Done.", tone: "done" }]);
        setActivity("done");
        setTimeout(() => setActivity("idle"), 1500);
      } else {
        setRunStatus("failed");
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Failed${ev.message ? ": " + ev.message : ""}`, tone: "error" }]);
        setActivity("idle");
      }
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const sendMessage = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || busy) return;
    const url = droppedUrl;
    setDroppedUrl(undefined);
    setBusy(true);
    setActivity("working");
    setItems((prev) => [...prev, { kind: "user", id: newId(), text: message }]);

    const history: ChatTurn[] = itemsRef.current
      .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
      .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));

    const res = await window.bean.chat({ history, message, droppedUrl: url });

    setItems((prev) => {
      const next = [...prev];
      if (res.reply.trim()) next.push({ kind: "reply", id: newId(), text: res.reply });
      if (res.proposedRun) next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
      return next;
    });
    setBusy(false);
    setActivity("idle");
  };

  const confirmProposal = (id: string, editedPrompt: string, run: RouteSuggestion): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" } : it)));
    setCurrentRun({ skillName: run.skillName, projectPath: run.projectPath, prompt: editedPrompt });
    void window.bean.run({ ...run, composedPrompt: editedPrompt });
  };

  const cancelProposal = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "cancelled" } : it)));
  };

  return (
    <div class="bean-dashboard">
      <TitleBar
        theme={theme}
        onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")}
        activity={activity}
      />
      <div class="bean-single-column">
        <CommandBarPanel droppedUrl={droppedUrl} busy={busy} onSend={sendMessage} />
        <ChatPanel items={items} busy={busy} onSend={sendMessage} onConfirm={confirmProposal} onCancel={cancelProposal} />
        <ConsolePanel run={currentRun} lines={terminal.lines} status={runStatus} startedAt={startedAt} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the bootstrap and HTML**

```tsx
// packages/app/src/renderer/components/chat/index.tsx
import { render } from "preact";
import { ChatWindow } from "./ChatWindow.js";

const root = document.getElementById("root");
if (root) render(<ChatWindow />, root);
```

```html
<!-- packages/app/src/renderer/chat.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/chat/index.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Verify**

No automated test (renderer UI, per this repo's established convention — verified manually in
Task 10). Confirm no leftover references: `grep -rn "dashboard/panels/ChatPanel\|dashboard/panels/CommandBarPanel\|dashboard/panels/ConsolePanel" packages/app/src` should print nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/chat packages/app/src/renderer/chat.html \
  packages/app/src/renderer/dashboard
git commit -m "refactor(app): extract Chat into its own component window"
```

---

### Task 6: Skills window

**Files:**
- Create: `packages/app/src/renderer/components/skills/index.tsx`
- Create: `packages/app/src/renderer/components/skills/SkillsWindow.tsx`
- Create: `packages/app/src/renderer/components/skills/SkillsPanel.tsx` (from
  `dashboard/panels/SkillsPanel.tsx`, import path updated)
- Create: `packages/app/src/renderer/skills.html`
- Delete: `packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx`

**Interfaces:**
- Consumes: `TitleBar`, `PanelHeader` (Task 4); `window.bean.proposeRun` (Task 2).
- Produces: `SkillsWindow` component, mounted by `index.tsx`.

- [ ] **Step 1: Move and fix up `SkillsPanel.tsx`**

```bash
mkdir -p packages/app/src/renderer/components/skills
git mv packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx packages/app/src/renderer/components/skills/SkillsPanel.tsx
```

Change its import line from:
```tsx
import { PanelHeader } from "../Panel.js";
```
to:
```tsx
import { PanelHeader } from "../../shared/Panel.js";
```
(no other change — its `onRunSkill` prop signature is unchanged.)

- [ ] **Step 2: Write `SkillsWindow.tsx`**

```tsx
// packages/app/src/renderer/components/skills/SkillsWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { TitleBar } from "../../shared/TitleBar.js";
import { SkillsPanel } from "./SkillsPanel.js";
import type { RouteSuggestion } from "@bean/core";
import type { Theme } from "../../../channels.js";

export function SkillsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const onRunSkill = (run: RouteSuggestion): void => {
    window.bean.proposeRun(run);
  };

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")} />
      <div class="bean-single-column">
        <SkillsPanel onRunSkill={onRunSkill} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the bootstrap and HTML**

```tsx
// packages/app/src/renderer/components/skills/index.tsx
import { render } from "preact";
import { SkillsWindow } from "./SkillsWindow.js";

const root = document.getElementById("root");
if (root) render(<SkillsWindow />, root);
```

```html
<!-- packages/app/src/renderer/skills.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/skills/index.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Verify**

`grep -rn "dashboard/panels/SkillsPanel" packages/app/src` should print nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/skills packages/app/src/renderer/skills.html \
  packages/app/src/renderer/dashboard
git commit -m "refactor(app): extract Skills into its own component window"
```

---

### Task 7: Persona window

**Files:**
- Create: `packages/app/src/renderer/components/persona/index.tsx`
- Create: `packages/app/src/renderer/components/persona/PersonaWindow.tsx`
- Create: `packages/app/src/renderer/components/persona/PersonaPanel.tsx` (from
  `dashboard/panels/PersonaPanel.tsx`, import path updated)
- Create: `packages/app/src/renderer/persona.html`
- Delete: `packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx`

**Interfaces:**
- Consumes: `TitleBar`, `PanelHeader` (Task 4).
- Produces: `PersonaWindow` component, mounted by `index.tsx`.

- [ ] **Step 1: Move and fix up `PersonaPanel.tsx`**

```bash
mkdir -p packages/app/src/renderer/components/persona
git mv packages/app/src/renderer/dashboard/panels/PersonaPanel.tsx packages/app/src/renderer/components/persona/PersonaPanel.tsx
```

Change its import line from `import { PanelHeader } from "../Panel.js";` to
`import { PanelHeader } from "../../shared/Panel.js";` (no other change).

- [ ] **Step 2: Write `PersonaWindow.tsx`**

```tsx
// packages/app/src/renderer/components/persona/PersonaWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { TitleBar } from "../../shared/TitleBar.js";
import { PersonaPanel } from "./PersonaPanel.js";
import type { Theme } from "../../../channels.js";

export function PersonaWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")} />
      <div class="bean-single-column">
        <PersonaPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the bootstrap and HTML**

```tsx
// packages/app/src/renderer/components/persona/index.tsx
import { render } from "preact";
import { PersonaWindow } from "./PersonaWindow.js";

const root = document.getElementById("root");
if (root) render(<PersonaWindow />, root);
```

```html
<!-- packages/app/src/renderer/persona.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/persona/index.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Verify**

`grep -rn "dashboard/panels/PersonaPanel" packages/app/src` should print nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/components/persona packages/app/src/renderer/persona.html \
  packages/app/src/renderer/dashboard
git commit -m "refactor(app): extract Persona into its own component window"
```

---

### Task 8: Projects window

**Files:**
- Create: `packages/app/src/renderer/components/projects/index.tsx`
- Create: `packages/app/src/renderer/components/projects/ProjectsWindow.tsx`
- Create: `packages/app/src/renderer/components/projects/ProjectsPanel.tsx` (from
  `dashboard/panels/ProjectsPanel.tsx`, import paths updated + drop `bean-panel--wide`)
- Create: `packages/app/src/renderer/components/projects/TaskMonitor.tsx` (from
  `dashboard/TaskMonitor.tsx`, import paths updated)
- Create: `packages/app/src/renderer/projects.html`
- Delete: `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`,
  `packages/app/src/renderer/dashboard/TaskMonitor.tsx`

**Interfaces:**
- Consumes: `TitleBar`, `PanelHeader`, `TaskCard`, `formatElapsed` (Task 4);
  `window.bean.listProjects`, `.launchTask`, `.cancelTask`, `.onTaskEvent` (Task 2, unchanged).
- Produces: `ProjectsWindow` component, mounted by `index.tsx`.

- [ ] **Step 1: Move and fix up `ProjectsPanel.tsx` and `TaskMonitor.tsx`**

```bash
mkdir -p packages/app/src/renderer/components/projects
git mv packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx packages/app/src/renderer/components/projects/ProjectsPanel.tsx
git mv packages/app/src/renderer/dashboard/TaskMonitor.tsx packages/app/src/renderer/components/projects/TaskMonitor.tsx
```

In `ProjectsPanel.tsx`, change:
```tsx
import { PanelHeader } from "../Panel.js";
import { TaskMonitor } from "../TaskMonitor.js";
```
to:
```tsx
import { PanelHeader } from "../../shared/Panel.js";
import { TaskMonitor } from "./TaskMonitor.js";
```
and change both `class="bean-panel bean-panel--wide"` occurrences (the empty-state div and the
main div) to `class="bean-panel"`.

In `TaskMonitor.tsx`, change:
```tsx
import { formatElapsed } from "./format.js";
import { LAUNCH_MODE_LABEL, type TaskCard } from "./task-types.js";
```
to:
```tsx
import { formatElapsed } from "../../shared/format.js";
import { LAUNCH_MODE_LABEL, type TaskCard } from "../../shared/task-types.js";
```

- [ ] **Step 2: Write `ProjectsWindow.tsx`**

```tsx
// packages/app/src/renderer/components/projects/ProjectsWindow.tsx
import { useEffect, useState } from "preact/hooks";
import { TitleBar } from "../../shared/TitleBar.js";
import { ProjectsPanel } from "./ProjectsPanel.js";
import type { Project, LaunchMode, TaskEvent } from "@bean/core";
import type { Theme } from "../../../channels.js";
import type { TaskCard } from "../../shared/task-types.js";

export function ProjectsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskCard[]>([]);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    void window.bean.listProjects().then(setProjects);
    window.bean.onTaskEvent((ev: TaskEvent) => {
      setTasks((prev) => prev.map((t) => (t.taskId === ev.taskId ? { ...t, ...ev } : t)));
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function capTasks(list: TaskCard[]): TaskCard[] {
    if (list.length <= 20) return list;
    const idx = list.findIndex((t) => t.status !== "running");
    return idx === -1 ? list : [...list.slice(0, idx), ...list.slice(idx + 1)];
  }

  const launchTask = (mode: LaunchMode, project: Project, prompt?: string): void => {
    const taskId = crypto.randomUUID();
    setTasks((prev) => capTasks([
      ...prev,
      { taskId, mode, projectName: project.name, prompt, status: "running", startedAt: Date.now() },
    ]));
    void window.bean.launchTask(taskId, { mode, projectPath: project.path, projectName: project.name, prompt });
  };

  const cancelTask = (taskId: string): void => {
    setTasks((prev) => prev.map((t) => (t.taskId === taskId ? { ...t, cancelling: true } : t)));
    void window.bean.cancelTask(taskId);
  };

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")} />
      <div class="bean-single-column">
        <ProjectsPanel projects={projects} tasks={tasks} onLaunch={launchTask} onCancel={cancelTask} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the bootstrap and HTML**

```tsx
// packages/app/src/renderer/components/projects/index.tsx
import { render } from "preact";
import { ProjectsWindow } from "./ProjectsWindow.js";

const root = document.getElementById("root");
if (root) render(<ProjectsWindow />, root);
```

```html
<!-- packages/app/src/renderer/projects.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/projects/index.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Delete the now-empty old dashboard renderer files**

```bash
git rm packages/app/src/renderer/dashboard/App.tsx
git rm packages/app/src/renderer/dashboard.tsx
git rm packages/app/src/renderer/dashboard.html
rmdir packages/app/src/renderer/dashboard/panels packages/app/src/renderer/dashboard 2>/dev/null || true
```

- [ ] **Step 5: Verify**

`grep -rn "dashboard/panels/ProjectsPanel\|dashboard/TaskMonitor\|dashboard/App\b" packages/app/src`
should print nothing. `ls packages/app/src/renderer/dashboard` should fail ("No such file or
directory") — the whole old folder is gone.

- [ ] **Step 6: Commit**

```bash
git add -A packages/app/src/renderer
git commit -m "refactor(app): extract Projects into its own component window; remove old dashboard folder"
```

---

### Task 9: Avatar bubble menu

**Files:**
- Modify: `packages/app/src/renderer/avatar.html`
- Modify: `packages/app/src/renderer/avatar.ts`
- Create: `packages/app/src/renderer/bubble-menu.css`

**Interfaces:**
- Consumes: `window.bean.openComponent`, `.setAvatarMenuOpen` (Task 2); `ComponentKind`
  (Task 2, imported as a type only).
- Produces: nothing consumed elsewhere — this is the final piece of user-facing behavior.

- [ ] **Step 1: Update `avatar.html`**

```html
<!-- packages/app/src/renderer/avatar.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="bubble-menu.css" />
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      body {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #bean {
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <div id="bean" title="Bean"></div>
    <div id="bean-menu" class="bean-menu">
      <button type="button" class="bean-bubble-btn bean-bubble-btn--chat" data-kind="chat">Chat</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--skills" data-kind="skills">Skills</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--persona" data-kind="persona">Persona</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--projects" data-kind="projects">Projects</button>
    </div>
    <script type="module" src="avatar.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `bubble-menu.css`**

```css
/* packages/app/src/renderer/bubble-menu.css */
.bean-menu {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 10;
}
.bean-menu--open {
  opacity: 1;
  pointer-events: auto;
}
.bean-bubble-btn {
  position: absolute;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  border: 1px solid var(--bean-border);
  background: var(--bean-surface);
  color: var(--bean-text);
  font: 600 11px ui-monospace, monospace;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transform: translate(-50%, -50%);
}
.bean-bubble-btn:hover { border-color: var(--bean-accent); }
.bean-bubble-btn--chat { transform: translate(-50%, -50%) translateY(-110px); }
.bean-bubble-btn--skills { transform: translate(-50%, -50%) translateX(110px); }
.bean-bubble-btn--persona { transform: translate(-50%, -50%) translateY(110px); }
.bean-bubble-btn--projects { transform: translate(-50%, -50%) translateX(-110px); }
```

- [ ] **Step 3: Update `avatar.ts`**

```ts
// packages/app/src/renderer/avatar.ts
import { createOrb } from "./orb.js";
import type { ComponentKind } from "../channels.js";

// The window is reused for the avatar's whole lifetime now — it never navigates
// to another page — so this fixed size only needs to be set once.
window.resizeTo(120, 120);

// The window body is the drag region (so you can move the avatar around).
// The #bean element is explicitly NO-drag: a `-webkit-app-region: drag` element
// is treated by macOS as an OS window-move handle and swallows mouse events, so
// the dblclick/drop listeners must live on a no-drag element to fire at all.
(document.body.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "drag";

const el = document.getElementById("bean");
const menu = document.getElementById("bean-menu");

if (el) {
  (el.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "no-drag";

  const orb = createOrb(el, { size: 96 });
  orb.setState("idle");

  window.bean.getTheme().then((t) => { document.documentElement.dataset.theme = t; });
  window.bean.onThemeChanged((t) => { document.documentElement.dataset.theme = t; });

  // Bubble menu: dblclick toggles it; picking a bubble opens that component and
  // closes the menu; clicking outside it or pressing Escape also closes it.
  let menuOpen = false;
  const setMenuOpen = (open: boolean): void => {
    menuOpen = open;
    menu?.classList.toggle("bean-menu--open", open);
    window.bean.setAvatarMenuOpen(open);
  };

  el.addEventListener("dblclick", () => { setMenuOpen(!menuOpen); });

  menu?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-bubble-btn");
    if (!btn) return;
    void window.bean.openComponent(btn.dataset.kind as ComponentKind);
    setMenuOpen(false);
  });

  window.addEventListener("click", (e) => {
    if (!menuOpen) return;
    const target = e.target as HTMLElement;
    if (target === el || target.closest(".bean-bubble-btn")) return;
    setMenuOpen(false);
  });

  window.addEventListener("keydown", (e) => {
    if (menuOpen && e.key === "Escape") setMenuOpen(false);
  });

  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url) void window.bean.openComponent("chat", url);
  });

  // #bean is no-drag (see comment above), so dragging the visible body itself is done
  // manually: track mouse deltas and move the OS window via IPC instead of CSS drag.
  // Disabled while the bubble menu is open so the grown window can't be dragged mid-pick.
  let dragging = false;
  let lastX = 0, lastY = 0;
  el.addEventListener("mousedown", (e) => {
    if (menuOpen) return;
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    window.bean.moveWindowBy(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX;
    lastY = e.screenY;
  });
  window.addEventListener("mouseup", () => { dragging = false; });
}
```

- [ ] **Step 4: Verify**

No automated test (renderer UI). `grep -n "openDashboard\|onDashboardDroppedUrl" packages/app/src/renderer/avatar.ts`
should print nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/avatar.html packages/app/src/renderer/avatar.ts \
  packages/app/src/renderer/bubble-menu.css
git commit -m "feat(app): bubble menu on the avatar replaces direct dashboard open"
```

---

### Task 10: esbuild config, `shared.css`, final gate, ledger update

**Files:**
- Modify: `packages/app/esbuild.config.mjs`
- Create: `packages/app/src/renderer/shared.css` (renamed from `dashboard.css`, plus edits)
- Delete: `packages/app/src/renderer/dashboard.css`
- Modify: `docs/superpowers/bean-redesign-playbook.md` (ledger row)
- Modify: `.memory/project-dashboard-redesign-roadmap.md` (status note)

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: nothing further — this closes out the SP.

- [ ] **Step 1: Rename and edit the stylesheet**

```bash
git mv packages/app/src/renderer/dashboard.css packages/app/src/renderer/shared.css
```

In `shared.css`, replace the `.bean-dashboard-grid` block:
```css
.bean-dashboard-grid {
  flex: 1;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding: 24px;
}
```
with:
```css
.bean-single-column {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
}
.bean-single-column > .bean-panel {
  flex: 1;
  min-height: 260px;
}
```
and delete the now-unused `.bean-panel--wide { grid-column: 1 / 3; }` rule immediately below the
`.bean-panel` block (every consumer of `bean-panel--wide` was already switched to plain
`bean-panel` in Tasks 5 and 8).

- [ ] **Step 2: Update `esbuild.config.mjs`**

Change the `rendererOpts.entryPoints` array from:
```js
entryPoints: ["src/renderer/avatar.ts", "src/renderer/dashboard.tsx"],
```
to:
```js
entryPoints: [
  "src/renderer/avatar.ts",
  "src/renderer/components/chat/index.tsx",
  "src/renderer/components/skills/index.tsx",
  "src/renderer/components/persona/index.tsx",
  "src/renderer/components/projects/index.tsx",
],
```

Change `copyStaticAssets()` from:
```js
function copyStaticAssets() {
  mkdirSync("dist/renderer", { recursive: true });
  for (const f of ["avatar", "dashboard"]) {
    cpSync(`src/renderer/${f}.html`, `dist/renderer/${f}.html`);
  }
  for (const f of ["theme.css", "orb.css", "dashboard.css"]) {
    cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
  }
}
```
to:
```js
function copyStaticAssets() {
  mkdirSync("dist/renderer", { recursive: true });
  for (const f of ["avatar", "chat", "skills", "persona", "projects"]) {
    cpSync(`src/renderer/${f}.html`, `dist/renderer/${f}.html`);
  }
  for (const f of ["theme.css", "orb.css", "shared.css", "bubble-menu.css"]) {
    cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
  }
}
```

- [ ] **Step 3: Run the full gate**

Run: `rm -rf packages/app/dist && pnpm test && pnpm typecheck && pnpm build`
Expected: all three exit 0. If typecheck fails, the error will name the file/symbol still
referencing something removed in Task 2 (most likely a stray `openDashboard`/`sender`
reference) — grep for it across `packages/app/src` and fix in place; this is the point where the
deferred gate from the Global Constraints section finally closes.

- [ ] **Step 4: Spot-check the built output**

Run: `ls packages/app/dist/renderer packages/app/dist/renderer/components/chat`
Expected: `dist/renderer/` contains `avatar.html`, `avatar.js`, `chat.html`, `skills.html`,
`persona.html`, `projects.html`, `theme.css`, `orb.css`, `shared.css`, `bubble-menu.css`, and a
`components/` subfolder; `dist/renderer/components/chat/` contains `index.js`.

- [ ] **Step 5: Update the playbook ledger and roadmap memory**

In `docs/superpowers/bean-redesign-playbook.md`, change the SP8 row's Plan column from
`*(pending)*` to `` `plans/2026-07-01-bean-component-windows.md` `` and its Status from
`📝 spec written + approved; plan not yet written` to `✅ done + reviewed` (fill in the actual
review outcome once Task 6 of the manual checklist below has been run).

In `.memory/project-dashboard-redesign-roadmap.md`, replace the sentence "plan not yet written."
in the SP8 paragraph with a short note that it's implemented, e.g. "Implemented in
`plans/2026-07-01-bean-component-windows.md`; both flagged wiring changes (run/task-event
routing, `IPC.proposeRun`) landed as designed."

- [ ] **Step 6: Manual verification checklist**

Run `pnpm dev` (from repo root) and confirm, one by one:
- Double-click the bean → 4 bubbles fade in around it; the avatar window visibly grows,
  centered on the bean's prior position.
- Click each bubble once → its window opens; clicking the same bubble again while that window
  is open focuses the existing window instead of opening a second one.
- Click empty space in the grown avatar window (not the bean, not a bubble) → menu closes, no
  window opens. Press Escape with the menu open → same.
- Double-click the bean again while the menu is open → menu closes (toggle-off).
- While the menu is open, try to drag the bean → it does not move.
- Drop a URL on the bean → the Chat window opens/focuses with that URL available.
- Toggle Hearth/Graphite in any one component window → the other open windows restyle too.
- From Skills, click "Run skill" → the Chat window opens/focuses and shows a `ProposalCard` for
  that skill; confirming it shows live output in Chat's console section.
- From Projects, launch a task → its status/progress updates live in the Projects window.

- [ ] **Step 7: Commit**

```bash
git add packages/app/esbuild.config.mjs packages/app/src/renderer/shared.css \
  docs/superpowers/bean-redesign-playbook.md .memory/project-dashboard-redesign-roadmap.md
git commit -m "feat(app): wire esbuild for per-component windows; SP8 done"
```
