# Bean Settings, About & Right-click Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click context menu on the Bean avatar (Settings · Persona · About), a Settings window that live-edits `~/.bean/config.json`, an About window, and clean up the fake "subwindow" chrome so component windows match the chat window.

**Architecture:** `@bean/core` gains a pure `saveConfig` writer. `@bean/app` gains a pure `runtime-config` holder so the OpenAI clients rebuild on save without a restart. Two new component windows (settings, about) reuse the existing per-kind window system. The right-click menu reuses the avatar's existing window-growth/auto-fold machinery with a tighter dedicated size. Chrome cleanup removes the in-app `TitleBar` and fake macOS traffic lights, leaving only native window chrome.

**Tech Stack:** TypeScript (ESM, `strict` + `noUncheckedIndexedAccess`), Electron, Preact, esbuild, Vitest. pnpm-workspace monorepo.

## Global Constraints

- Node ≥24, pnpm 11. Both packages are ESM (`"type": "module"`, `verbatimModuleSyntax`): use `.js` extensions in relative imports and `import type` for type-only imports.
- The Electron preload stays CommonJS `.cjs` (`.memory/safety-preload-must-be-cjs.md`).
- IPC channel names are declared once in `packages/app/src/channels.ts` — never string-literalled (`.memory/convention-ipc-channels.md`).
- New IO goes in `@bean/core` as pure, dependency-injected functions; Electron wiring stays in `app/` (`.memory/convention-core-is-electron-free.md`).
- Avatar popups must be real, properly-sized `-webkit-app-region: no-drag` elements (`.memory/safety-window-behavior.md`).
- The on-disk `~/.bean/config.json` holds only `{ openaiApiKey, model }` (never `beanDir`).
- Author string is exactly `Scen.K`. Copyright year and app version are computed at runtime, never hardcoded.
- Validation gate: `pnpm test && pnpm typecheck` both exit 0 before any task is considered done.

---

### Task 1: Core `saveConfig` writer

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Consumes: existing `loadConfig(file, beanDirPath)`, `configFile(dir)` from `config.ts`.
- Produces: `saveConfig(file: string, config: { openaiApiKey: string; model: string }): Promise<void>` — creates the parent dir and writes pretty JSON with a trailing newline. Only `openaiApiKey` + `model` are written.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__test__/config.test.ts` (note the new imports `saveConfig`, and `mkdir` is already covered by `writeFile`/`rm` usage):

```ts
import { loadConfig, saveConfig, skillsDir, projectsFile, configFile, personaFile } from "../src/config.js";

test("saveConfig round-trips openaiApiKey and model", async () => {
  const file = join(dir, "sub", "config.json"); // nested to prove mkdir -p
  await saveConfig(file, { openaiApiKey: "sk-new", model: "gpt-5" });
  const cfg = await loadConfig(file, "/b");
  expect(cfg.openaiApiKey).toBe("sk-new");
  expect(cfg.model).toBe("gpt-5");
});

test("saveConfig writes only openaiApiKey and model (no beanDir)", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m" });
  const parsed = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(parsed).sort()).toEqual(["model", "openaiApiKey"]);
});
```

Add `readFile` to the existing `node:fs/promises` import in the test file:

```ts
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: FAIL — `saveConfig is not a function` / import error.

- [ ] **Step 3: Implement `saveConfig`**

In `packages/core/src/config.ts`, update the imports and append the function:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
```

```ts
export async function saveConfig(
  file: string,
  config: { openaiApiKey: string; model: string },
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const out = { openaiApiKey: config.openaiApiKey, model: config.model };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): add saveConfig writer for ~/.bean/config.json"
```

---

### Task 2: App `runtime-config` live-reload holder

**Files:**
- Create: `packages/app/src/runtime-config.ts`
- Test: `packages/app/__test__/runtime-config.test.ts`

**Interfaces:**
- Consumes: `RouterDeps`, `ConverseDeps` types from `@bean/core`.
- Produces: `createRuntimeConfig(initial, deps)` returning a `RuntimeConfig` object with **stable** `chat` / `converse` wrappers (identity never changes, so IPC handlers built once always call the current client), plus `getModel()`, `getApiKey()`, and `apply(update)`:

```ts
export interface RuntimeConfigDeps {
  makeChat: (apiKey: string) => RouterDeps["chat"];
  makeConverse: (apiKey: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string }) => Promise<void>;
}
export interface RuntimeConfig {
  chat: RouterDeps["chat"];
  converse: ConverseDeps["chat"];
  getModel: () => string;
  getApiKey: () => string;
  apply: (update: { openaiApiKey: string; model: string }) => Promise<void>;
}
export function createRuntimeConfig(
  initial: { openaiApiKey: string; model: string },
  deps: RuntimeConfigDeps,
): RuntimeConfig;
```

- [ ] **Step 1: Write the failing test**

Create `packages/app/__test__/runtime-config.test.ts`:

```ts
import { expect, test } from "vitest";
import { createRuntimeConfig } from "../src/runtime-config.js";

test("apply saves config and rebuilds clients with the new key", async () => {
  const saved: { openaiApiKey: string; model: string }[] = [];
  const madeChat: string[] = [];
  const rt = createRuntimeConfig(
    { openaiApiKey: "sk-old", model: "gpt-4o-mini" },
    {
      makeChat: (k) => { madeChat.push(k); return (async () => "chat:" + k) as never; },
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async (u) => { saved.push(u); },
    },
  );

  expect(rt.getModel()).toBe("gpt-4o-mini");
  expect(rt.getApiKey()).toBe("sk-old");
  expect(madeChat).toEqual(["sk-old"]);

  await rt.apply({ openaiApiKey: "sk-new", model: "gpt-5" });

  expect(saved).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5" }]);
  expect(rt.getModel()).toBe("gpt-5");
  expect(rt.getApiKey()).toBe("sk-new");
  expect(madeChat).toEqual(["sk-old", "sk-new"]);
});

test("the stable chat wrapper delegates to the current client after apply", async () => {
  const rt = createRuntimeConfig(
    { openaiApiKey: "a", model: "m" },
    {
      makeChat: (k) => (async () => "R:" + k) as never,
      makeConverse: () => (async () => ({ content: "", toolCalls: [] })) as never,
      saveConfigFile: async () => {},
    },
  );
  const wrapper = rt.chat;
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:a");
  await rt.apply({ openaiApiKey: "b", model: "m" });
  // same wrapper reference, new underlying client
  expect(rt.chat).toBe(wrapper);
  expect(await (wrapper as never as () => Promise<string>)()).toBe("R:b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/runtime-config.test.ts`
Expected: FAIL — cannot find module `../src/runtime-config.js`.

- [ ] **Step 3: Implement `runtime-config.ts`**

Create `packages/app/src/runtime-config.ts`:

```ts
import type { RouterDeps, ConverseDeps } from "@bean/core";

export interface RuntimeConfigDeps {
  makeChat: (apiKey: string) => RouterDeps["chat"];
  makeConverse: (apiKey: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string }) => Promise<void>;
}

export interface RuntimeConfig {
  chat: RouterDeps["chat"];
  converse: ConverseDeps["chat"];
  getModel: () => string;
  getApiKey: () => string;
  apply: (update: { openaiApiKey: string; model: string }) => Promise<void>;
}

// Holds the live OpenAI clients + model behind stable wrapper functions. IPC handlers close
// over the wrappers once at startup; apply() swaps the underlying clients in place so a Settings
// save takes effect on the next chat/route with no restart (see the Settings window).
export function createRuntimeConfig(
  initial: { openaiApiKey: string; model: string },
  deps: RuntimeConfigDeps,
): RuntimeConfig {
  let apiKey = initial.openaiApiKey;
  let model = initial.model;
  let chatClient = deps.makeChat(apiKey);
  let converseClient = deps.makeConverse(apiKey);

  return {
    chat: ((...args: Parameters<RouterDeps["chat"]>) => chatClient(...args)) as RouterDeps["chat"],
    converse: ((...args: Parameters<ConverseDeps["chat"]>) => converseClient(...args)) as ConverseDeps["chat"],
    getModel: () => model,
    getApiKey: () => apiKey,
    apply: async (update) => {
      await deps.saveConfigFile({ openaiApiKey: update.openaiApiKey, model: update.model });
      apiKey = update.openaiApiKey;
      model = update.model;
      chatClient = deps.makeChat(apiKey);
      converseClient = deps.makeConverse(apiKey);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/runtime-config.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/runtime-config.ts packages/app/__test__/runtime-config.test.ts
git commit -m "feat(app): add runtime-config holder for live config reload"
```

---

### Task 3: Wire config/app-info IPC + switch handlers to getModel()

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/windows.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Test: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `createRuntimeConfig` (Task 2), core `saveConfig`/`configFile`/`skillsDir`/`projectsFile`/`personaFile` (Task 1 + existing).
- Produces:
  - `channels.ts`: `ComponentKind` includes `"settings" | "about"`; `AvatarMode` includes `"context"`; `IPC` includes `getConfig`, `saveConfig`, `getAppInfo`; new exported types `ConfigView`, `ConfigUpdate`, `AppInfo`.
  - `RouteHandlerDeps` / `ChatHandlerDeps`: `model: string` replaced by `getModel: () => string`.
  - `window.bean.getConfig(): Promise<ConfigView>`, `window.bean.saveConfig(u: ConfigUpdate): Promise<void>`, `window.bean.getAppInfo(): Promise<AppInfo>`.

- [ ] **Step 1: Extend channels + shared types**

In `packages/app/src/channels.ts`:

```ts
export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "plan" | "settings" | "about";
export type AvatarMode = "normal" | "menu" | "drag" | "context";

export interface ConfigView {
  openaiApiKey: string;
  model: string;
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
  openaiApiKey: string;
  model: string;
}
export interface AppInfo {
  version: string;
  author: string;
  description: string;
}
```

Add three channels inside the `IPC` object (keep the existing entries):

```ts
  getConfig: "bean:get-config",
  saveConfig: "bean:save-config",
  getAppInfo: "bean:get-app-info",
```

- [ ] **Step 2: Add window size/title records for settings + about**

In `packages/app/src/windows.ts`, extend both records so they stay exhaustive over `ComponentKind` (typecheck fails otherwise):

```ts
const COMPONENT_WINDOW_SIZE: Record<ComponentKind, { width: number; height: number }> = {
  chat: { width: 520, height: 640 },
  skills: { width: 1040, height: 720 },
  persona: { width: 1040, height: 720 },
  projects: { width: 1040, height: 720 },
  plan: { width: 480, height: 460 },
  settings: { width: 480, height: 560 },
  about: { width: 420, height: 380 },
};

const COMPONENT_WINDOW_TITLE: Record<ComponentKind, string> = {
  chat: "Chat",
  skills: "Skills",
  persona: "Persona",
  projects: "Projects",
  plan: "Plan",
  settings: "Settings",
  about: "About Bean",
};
```

- [ ] **Step 3: Update existing ipc tests to `getModel` (write the failing expectation first)**

In `packages/app/__test__/ipc.test.ts`, change the two handlers that pass `model: "m"` to `getModel: () => "m"`:

- In "route handler wires core pieces together": replace `model: "m",` with `getModel: () => "m",`.
- In "chat handler wires skills/projects/persona into converse": replace `model: "m",` with `getModel: () => "m",`.

Then add new tests for the config handlers at the end of the file:

```ts
import { buildConfigHandlers } from "../src/ipc.js";
import type { ConfigView, ConfigUpdate } from "../src/channels.js";

test("config get handler returns the injected view", () => {
  const view: ConfigView = {
    openaiApiKey: "sk-x", model: "m",
    paths: { config: "/b/config.json", skills: "/b/skills", projects: "/b/projects.json", persona: "/b/persona.json" },
  };
  const handlers = buildConfigHandlers({ getConfig: () => view, applyConfig: async () => {} });
  expect(handlers.get()).toBe(view);
});

test("config save handler forwards the update to applyConfig", async () => {
  const applied: ConfigUpdate[] = [];
  const handlers = buildConfigHandlers({
    getConfig: () => ({ openaiApiKey: "", model: "", paths: { config: "", skills: "", projects: "", persona: "" } }),
    applyConfig: async (u) => { applied.push(u); },
  });
  await handlers.save({ openaiApiKey: "sk-new", model: "gpt-5" });
  expect(applied).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5" }]);
});
```

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: FAIL — `buildConfigHandlers` not exported; type errors on `getModel`.

- [ ] **Step 4: Update `ipc.ts` — deps, handlers, wiring**

In `packages/app/src/ipc.ts`:

Add channel/type imports:

```ts
import { IPC, type Theme, type ComponentKind, type AvatarMode, type ConfigView, type ConfigUpdate, type AppInfo } from "./channels.js";
```

In `RouteHandlerDeps`, replace `model: string;` with `getModel: () => string;`. Update `buildRouteHandler`'s `route(...)` call:

```ts
return route(input, skills, projects, { chat: deps.chat, model: deps.getModel() });
```

In `ChatHandlerDeps`, replace `model: string;` with `getModel: () => string;`. Update `buildChatHandler`'s `converse(...)` call:

```ts
return converse(req.history, req.message, skills, projects, persona, { chat: deps.converse, model: deps.getModel() }, req.droppedUrl);
```

Add a config-handlers builder (mirrors `buildPersonaHandlers`):

```ts
export interface ConfigHandlerDeps {
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
}

export function buildConfigHandlers(deps: ConfigHandlerDeps) {
  return {
    get: (): ConfigView => deps.getConfig(),
    save: (update: ConfigUpdate): Promise<void> => deps.applyConfig(update),
  };
}
```

Extend `RegisterDeps` (it `extends RouteHandlerDeps` so `getModel` is inherited; add the rest):

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
  planFromDrop: (skillName: string, droppedUrl: string) => void;
  getConfig: () => ConfigView;
  applyConfig: (update: ConfigUpdate) => Promise<void>;
  getAppInfo: () => AppInfo;
  spawnLaunch?: LaunchSpawnFn;
}
```

Note `ChatHandlerDeps` is not extended by `RegisterDeps`, but `buildChatHandler(deps)` is called with `deps` in `registerIpc`; since `RegisterDeps` now has `getModel` (via `RouteHandlerDeps`) and `converse`, and already has the skills/projects/persona fields, it structurally satisfies `ChatHandlerDeps`. Confirm no missing field at Step 6 typecheck.

Update the `getModel` IPC handler and register the new channels inside `registerIpc` (place near the persona handlers):

```ts
ipcMain.handle(IPC.getModel, () => deps.getModel());
```

```ts
const configHandlers = buildConfigHandlers({ getConfig: deps.getConfig, applyConfig: deps.applyConfig });
ipcMain.handle(IPC.getConfig, () => configHandlers.get());
ipcMain.handle(IPC.saveConfig, (_e, update: ConfigUpdate) => configHandlers.save(update));
ipcMain.handle(IPC.getAppInfo, () => deps.getAppInfo());
```

- [ ] **Step 5: Update `main.ts` to build the runtime + provide new deps**

In `packages/app/src/main.ts`:

Update the `@bean/core` import to add `saveConfig`:

```ts
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile,
  loadConfig, loadSkills, loadProjects, saveSkill, loadPersona, savePersona, saveConfig,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill,
} from "@bean/core";
```

Add the runtime-config import:

```ts
import { createRuntimeConfig } from "./runtime-config.js";
```

Inside the `try` block, replace the `registerIpc({...})` call. Build the runtime from the loaded config, then pass the wrappers/getters and new deps:

```ts
    const cfg = await loadConfig(configFile(dir), dir);
    if (cfg.openaiApiKey === "") {
      dialog.showErrorBox("Bean", "Missing openaiApiKey in ~/.bean/config.json");
    }

    const runtime = createRuntimeConfig(
      { openaiApiKey: cfg.openaiApiKey, model: cfg.model },
      {
        makeChat: makeOpenAIChat,
        makeConverse: makeOpenAIConverse,
        saveConfigFile: (update) => saveConfig(configFile(dir), update),
      },
    );

    registerIpc(ipcMain, {
      loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
      chat: runtime.chat,
      converse: runtime.converse,
      getModel: runtime.getModel,
      skillsDir: skillsDir(dir),
      projectsFile: projectsFile(dir),
      personaFile: personaFile(dir),
      chatSender: () => componentWindows.get("chat")?.webContents,
      projectsSender: () => componentWindows.get("projects")?.webContents,
      getConfig: () => ({
        openaiApiKey: runtime.getApiKey(),
        model: runtime.getModel(),
        paths: {
          config: configFile(dir),
          skills: skillsDir(dir),
          projects: projectsFile(dir),
          persona: personaFile(dir),
        },
      }),
      applyConfig: (update) => runtime.apply(update),
      getAppInfo: () => ({
        version: app.getVersion(),
        author: "Scen.K",
        description: "Bean routes a loose instruction to one of your skills and projects, then runs it with opencode.",
      }),
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
    });
```

- [ ] **Step 6: Add preload + type surface**

In `packages/app/src/preload.ts`, add the type imports and three bridge methods:

```ts
import { IPC, type Theme, type ComponentKind, type AvatarMode, type ConfigView, type ConfigUpdate, type AppInfo } from "./channels.js";
```

```ts
  getConfig: (): Promise<ConfigView> => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: (update: ConfigUpdate): Promise<void> => ipcRenderer.invoke(IPC.saveConfig, update),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.getAppInfo),
```

In `packages/app/src/renderer/bean.d.ts`, add the imports and declarations to the `bean` interface:

```ts
import type { Theme, ComponentKind, AvatarMode, ConfigView, ConfigUpdate, AppInfo } from "../channels.js";
```

```ts
      getConfig(): Promise<ConfigView>;
      saveConfig(update: ConfigUpdate): Promise<void>;
      getAppInfo(): Promise<AppInfo>;
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts && pnpm --filter @bean/app typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/windows.ts packages/app/src/ipc.ts packages/app/src/main.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): wire config + app-info IPC and live-reload the OpenAI clients"
```

---

### Task 4: Settings window (with theme toggle)

**Files:**
- Create: `packages/app/src/renderer/settings.html`
- Create: `packages/app/src/renderer/components/settings/SettingsWindow.tsx`
- Create: `packages/app/src/renderer/components/settings/index.tsx`
- Modify: `packages/app/esbuild.config.mjs`
- Modify: `packages/app/src/renderer/shared.css`

**Interfaces:**
- Consumes: `window.bean.getConfig()`, `window.bean.saveConfig()`, `window.bean.getTheme()`, `window.bean.onThemeChanged()`, `window.bean.setTheme()` (Task 3 + existing); `PanelHeader` from `../../shared/Panel.js`.
- Produces: a renderer bundle at `dist/renderer/components/settings/index.js` loaded by `settings.html`; opened via `openComponent("settings")`.

- [ ] **Step 1: Register the renderer entry point + static copy**

In `packages/app/esbuild.config.mjs`, add to `rendererOpts.entryPoints`:

```js
    "src/renderer/components/settings/index.tsx",
```

And add `"settings"` to the html copy loop array:

```js
  for (const f of ["avatar", "chat", "skills", "persona", "projects", "plan", "settings"]) {
```

- [ ] **Step 2: Create the HTML shell**

Create `packages/app/src/renderer/settings.html` (mirrors `persona.html`):

```html
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
    <script type="module" src="components/settings/index.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the Settings window component**

Create `packages/app/src/renderer/components/settings/SettingsWindow.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { PanelHeader } from "../../shared/Panel.js";
import type { ConfigView } from "../../../channels.js";
import type { Theme } from "../../../channels.js";

type SaveState = "idle" | "saving" | "saved" | "error";

const PATH_LABELS: { key: keyof ConfigView["paths"]; label: string }[] = [
  { key: "config", label: "Config" },
  { key: "skills", label: "Skills" },
  { key: "projects", label: "Projects" },
  { key: "persona", label: "Persona" },
];

export function SettingsWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [paths, setPaths] = useState<ConfigView["paths"] | undefined>(undefined);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getConfig().then((c: ConfigView) => {
      setApiKey(c.openaiApiKey);
      setModel(c.model);
      setPaths(c.paths);
    });
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const onSave = async (): Promise<void> => {
    setSave("saving");
    setError(undefined);
    try {
      await window.bean.saveConfig({ openaiApiKey: apiKey.trim(), model: model.trim() });
      setSave("saved");
    } catch (err) {
      setSave("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div class="bean-dashboard">
      <div class="bean-single-column">
        <div class="bean-panel">
          <PanelHeader title="Settings" />
          <div class="bean-settings">
            <label class="bean-field">
              <span class="bean-field-label">OPENAI API KEY</span>
              <input
                class="bean-input"
                type="password"
                value={apiKey}
                placeholder="sk-…"
                onInput={(e) => { setApiKey((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
            </label>

            <label class="bean-field">
              <span class="bean-field-label">MODEL NAME</span>
              <input
                class="bean-input"
                type="text"
                value={model}
                placeholder="gpt-4o-mini"
                onInput={(e) => { setModel((e.target as HTMLInputElement).value); setSave("idle"); }}
              />
            </label>

            <div class="bean-field">
              <span class="bean-field-label">THEME</span>
              <button
                type="button"
                class="bean-btn"
                onClick={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")}
              >
                {theme === "hearth" ? "Switch to Graphite" : "Switch to Hearth"}
              </button>
            </div>

            <div class="bean-field">
              <span class="bean-field-label">DATA LOCATION (~/.bean)</span>
              <div class="bean-paths">
                {paths
                  ? PATH_LABELS.map(({ key, label }) => (
                      <div key={key} class="bean-path-row">
                        <span class="bean-path-label">{label}</span>
                        <span class="bean-path-value">{paths[key]}</span>
                      </div>
                    ))
                  : <div class="bean-path-row">Loading…</div>}
              </div>
            </div>

            {error ? <div class="bean-persona-error">Save failed: {error}</div> : null}

            <div class="bean-card-actions">
              <button type="button" class="bean-btn" disabled={save === "saving"} onClick={() => void onSave()}>
                {save === "saving" ? "Saving…" : save === "saved" ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

Create `packages/app/src/renderer/components/settings/index.tsx`:

```tsx
import { render } from "preact";
import { SettingsWindow } from "./SettingsWindow.js";

const root = document.getElementById("root");
if (root) render(<SettingsWindow />, root);
```

- [ ] **Step 4: Add Settings CSS**

Append to `packages/app/src/renderer/shared.css`:

```css
/* --- settings --- */
.bean-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 16px;
  overflow: auto;
}
.bean-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bean-field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--bean-text-dim);
}
.bean-paths {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bean-path-row {
  display: flex;
  gap: 10px;
  font: 11.5px ui-monospace, monospace;
}
.bean-path-label {
  flex: none;
  width: 64px;
  color: var(--bean-text-dim);
}
.bean-path-value {
  color: var(--bean-text);
  word-break: break-all;
}
```

- [ ] **Step 5: Build and verify the bundle exists**

Run: `pnpm --filter @bean/app build && test -f packages/app/dist/renderer/components/settings/index.js && test -f packages/app/dist/renderer/settings.html && echo OK`
Expected: prints `OK` (build succeeds, both artifacts present).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/app/esbuild.config.mjs packages/app/src/renderer/settings.html packages/app/src/renderer/components/settings/ packages/app/src/renderer/shared.css
git commit -m "feat(app): add Settings window editing ~/.bean/config.json with live reload"
```

---

### Task 5: About window

**Files:**
- Create: `packages/app/src/renderer/about.html`
- Create: `packages/app/src/renderer/components/about/AboutWindow.tsx`
- Create: `packages/app/src/renderer/components/about/index.tsx`
- Modify: `packages/app/esbuild.config.mjs`
- Modify: `packages/app/src/renderer/shared.css`

**Interfaces:**
- Consumes: `window.bean.getAppInfo()`, `window.bean.getTheme()`, `window.bean.onThemeChanged()` (Task 3 + existing); `PanelHeader`.
- Produces: renderer bundle at `dist/renderer/components/about/index.js` loaded by `about.html`; opened via `openComponent("about")`.

- [ ] **Step 1: Register the renderer entry point + static copy**

In `packages/app/esbuild.config.mjs`, add to `rendererOpts.entryPoints`:

```js
    "src/renderer/components/about/index.tsx",
```

Add `"about"` to the html copy loop array:

```js
  for (const f of ["avatar", "chat", "skills", "persona", "projects", "plan", "settings", "about"]) {
```

- [ ] **Step 2: Create the HTML shell**

Create `packages/app/src/renderer/about.html`:

```html
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
    <script type="module" src="components/about/index.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the About window component**

Create `packages/app/src/renderer/components/about/AboutWindow.tsx` (version comes from `getAppInfo`; the copyright year is computed at render time with `new Date().getFullYear()` — never hardcoded):

```tsx
import { useEffect, useState } from "preact/hooks";
import type { AppInfo, Theme } from "../../../channels.js";

export function AboutWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  const year = new Date().getFullYear();

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.getAppInfo().then(setInfo);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  return (
    <div class="bean-dashboard">
      <div class="bean-about">
        <div class="bean-about-name">Bean</div>
        <div class="bean-about-version">v{info?.version ?? "…"}</div>
        <p class="bean-about-desc">{info?.description ?? ""}</p>
        <div class="bean-about-meta">
          <div>Author · {info?.author ?? "Scen.K"}</div>
          <div>© {year} {info?.author ?? "Scen.K"}</div>
        </div>
      </div>
    </div>
  );
}
```

Create `packages/app/src/renderer/components/about/index.tsx`:

```tsx
import { render } from "preact";
import { AboutWindow } from "./AboutWindow.js";

const root = document.getElementById("root");
if (root) render(<AboutWindow />, root);
```

- [ ] **Step 4: Add About CSS**

Append to `packages/app/src/renderer/shared.css`:

```css
/* --- about --- */
.bean-about {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px;
  text-align: center;
}
.bean-about-name {
  font-size: 22px;
  font-weight: 800;
  color: var(--bean-text);
}
.bean-about-version {
  font: 12px ui-monospace, monospace;
  color: var(--bean-accent);
}
.bean-about-desc {
  margin: 8px 0 0;
  max-width: 320px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--bean-text-dim);
}
.bean-about-meta {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bean-text-dim);
}
```

- [ ] **Step 5: Build and verify the bundle exists**

Run: `pnpm --filter @bean/app build && test -f packages/app/dist/renderer/components/about/index.js && test -f packages/app/dist/renderer/about.html && echo OK`
Expected: prints `OK`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/app/esbuild.config.mjs packages/app/src/renderer/about.html packages/app/src/renderer/components/about/ packages/app/src/renderer/shared.css
git commit -m "feat(app): add About window with dynamic version and copyright year"
```

---

### Task 6: Right-click context menu + move Persona out of quick actions

**Files:**
- Modify: `packages/app/src/avatar-menu.ts`
- Test: `packages/app/__test__/avatar-menu.test.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/renderer/avatar.html`
- Modify: `packages/app/src/renderer/avatar.ts`
- Modify: `packages/app/src/renderer/bubble-menu.css`

**Interfaces:**
- Consumes: `avatarSizeForMode` / `nextAvatarBounds` (existing), `window.bean.openComponent`, `window.bean.setAvatarMode`, `window.bean.onAvatarFoldMenu` (existing).
- Produces: `AVATAR_CONTEXT_SIZE` constant; `avatarSizeForMode("context")` returns it; a `#bean-context` popup driven by `mode === "context"`; quick-actions bloom no longer contains Persona.

- [ ] **Step 1: Write the failing test for `avatarSizeForMode("context")`**

Add to `packages/app/__test__/avatar-menu.test.ts`:

```ts
import { AVATAR_CONTEXT_SIZE } from "../src/avatar-menu.js";

test("context mode grows to the tighter context size (smaller than the menu bloom)", () => {
  expect(avatarSizeForMode("context")).toBe(AVATAR_CONTEXT_SIZE);
  expect(AVATAR_CONTEXT_SIZE).toBeLessThan(avatarSizeForMode("menu"));
});
```

(If `avatarSizeForMode` / `AVATAR_MENU_SIZE` are not yet imported in this test file, add them to the existing import from `../src/avatar-menu.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/avatar-menu.test.ts`
Expected: FAIL — `AVATAR_CONTEXT_SIZE` undefined / `avatarSizeForMode` returns wrong value for `"context"`.

- [ ] **Step 3: Add the constant + mode size**

In `packages/app/src/avatar-menu.ts`, add the constant near the other size constants:

```ts
// The right-click context menu is a small 3-item card, so it uses a much tighter grown window
// than the 600px petal bloom — just big enough for the card to fan out beside the bean.
export const AVATAR_CONTEXT_SIZE = 360;
```

Update `avatarSizeForMode`:

```ts
export function avatarSizeForMode(mode: AvatarMode): number {
  if (mode === "menu") return AVATAR_MENU_SIZE;
  if (mode === "drag") return AVATAR_DRAG_SIZE;
  if (mode === "context") return AVATAR_CONTEXT_SIZE;
  return AVATAR_SIZE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/avatar-menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Treat `"context"` like `"menu"` for growth + auto-fold in `ipc.ts`**

In `packages/app/src/ipc.ts`, in the `setAvatarMode` handler, start the fold poll for the context menu too. Change:

```ts
    if (mode === "menu") startMenuPoll(win);
    else stopMenuPoll();
```

to:

```ts
    if (mode === "menu" || mode === "context") startMenuPoll(win);
    else stopMenuPoll();
```

The growth branch already handles any non-`drag`/non-`normal` mode via the final `else` (`nextAvatarBounds(cur, avatarSizeForMode(mode))`), so `"context"` grows symmetrically around the bean with no further change.

- [ ] **Step 6: Add the context menu element to `avatar.html`**

In `packages/app/src/renderer/avatar.html`, add the popup element after `#bean-menu`:

```html
    <div id="bean-context" class="bean-context"></div>
```

- [ ] **Step 7: Wire the right-click menu in `avatar.ts`**

In `packages/app/src/renderer/avatar.ts`:

Remove Persona from the quick-actions bloom — update `QUICK_ACTIONS`:

```ts
const QUICK_ACTIONS: { kind: ComponentKind; name: string; desc: string }[] = [
  { kind: "chat", name: "Chat", desc: "Ask Bean anything" },
  { kind: "skills", name: "Skills", desc: "Manage skills" },
  { kind: "projects", name: "Projects", desc: "Your projects" },
];
```

Add `const context = document.getElementById("bean-context");` next to the other element lookups, and include it in the guard `if (el && bloom && reading) {` → `if (el && bloom && reading && context) {`.

Define the context items and an open/close helper. Add this after `setMenuOpen` is defined (so both closers are available):

```ts
  const CONTEXT_ACTIONS: { kind: ComponentKind; label: string }[] = [
    { kind: "settings", label: "Settings" },
    { kind: "persona", label: "Persona" },
    { kind: "about", label: "About" },
  ];
  context.innerHTML = CONTEXT_ACTIONS.map(
    (a) => `<button type="button" class="bean-context-item" data-kind="${a.kind}">${a.label}</button>`,
  ).join("");

  const setContextOpen = (open: boolean): void => {
    context.classList.toggle("bean-context--open", open);
    setMode(open ? "context" : "normal");
  };
```

Make the two popups mutually exclusive. Update `setMenuOpen` to close the context menu when opening the bloom:

```ts
  const setMenuOpen = (open: boolean): void => {
    if (open) context.classList.remove("bean-context--open");
    menu?.classList.toggle("bean-menu--open", open);
    setMode(open ? "menu" : "normal");
  };
```

Add the `contextmenu` handler on the bean and a click handler on the items (place near the existing `menu?.addEventListener("click", …)` block):

```ts
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (mode === "menu") setMenuOpen(false);
    if (mode !== "normal" && mode !== "context") return;
    setContextOpen(true);
  });

  context.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-context-item");
    if (!btn) return;
    void window.bean.openComponent(btn.dataset.kind as ComponentKind);
    setContextOpen(false);
  });
```

Extend the fold-on-signal handler so the auto-fold poll also closes the context menu:

```ts
  window.bean.onAvatarFoldMenu(() => {
    if (mode === "menu") setMenuOpen(false);
    else if (mode === "context") setContextOpen(false);
  });
```

Extend the click-outside handler to also close the context menu. Replace the existing `window.addEventListener("click", …)` body with:

```ts
  window.addEventListener("click", (e) => {
    if (mode !== "menu" && mode !== "context") return;
    const target = e.target as HTMLElement;
    if (el.contains(target) || target.closest(".bean-petal--menu") || target.closest(".bean-context-item")) return;
    if (mode === "menu") setMenuOpen(false);
    else setContextOpen(false);
  });
```

Extend the Escape handler:

```ts
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (mode === "menu") setMenuOpen(false);
    else if (mode === "context") setContextOpen(false);
  });
```

Finally, guard the left-click drag/mouseup toggle so a right-click never trips the bubble menu. In the `mouseup` handler, the existing `if (dragging && !moved)` block only fires for `mode === "normal"`/`"menu"`; since `contextmenu` fires on right-button and `mousedown` already returns for `e.button !== 0`, no change is needed there — confirm by reading the handler.

- [ ] **Step 8: Add context menu CSS**

Append to `packages/app/src/renderer/bubble-menu.css`:

```css
/* Right-click context menu: a small vertical card near the bean. Positioned inside the
   tighter AVATAR_CONTEXT_SIZE (360px) window; percentages keep it beside the centered bean
   without clipping. Must be no-drag to receive clicks (see .memory/safety-window-behavior.md). */
.bean-context {
  position: absolute;
  left: 54%;
  top: 50%;
  width: 152px;
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 2px;
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 12px;
  box-shadow: 0 22px 44px -20px rgba(0, 0, 0, 0.75);
  opacity: 0;
  transform: scale(0.94);
  transform-origin: top left;
  transition: opacity 0.12s ease, transform 0.12s ease;
  pointer-events: none;
  z-index: 11;
  -webkit-app-region: no-drag;
}
.bean-context--open {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}
.bean-context-item {
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: var(--bean-text);
  background: transparent;
  border: 0;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.bean-context-item:hover,
.bean-context-item:focus-visible {
  background: color-mix(in oklab, var(--bean-accent) 16%, var(--bean-surface));
  color: var(--bean-accent);
}
```

- [ ] **Step 9: Build, typecheck, and run the avatar test**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app typecheck && pnpm --filter @bean/app exec vitest run __test__/avatar-menu.test.ts`
Expected: build succeeds; typecheck exits 0; test PASSES.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/avatar-menu.ts packages/app/__test__/avatar-menu.test.ts packages/app/src/ipc.ts packages/app/src/renderer/avatar.html packages/app/src/renderer/avatar.ts packages/app/src/renderer/bubble-menu.css
git commit -m "feat(app): add right-click context menu (Settings/Persona/About), drop Persona from quick actions"
```

---

### Task 7: Chrome cleanup — remove fake TitleBar + traffic lights

**Files:**
- Modify: `packages/app/src/renderer/components/persona/PersonaWindow.tsx`
- Modify: `packages/app/src/renderer/components/skills/SkillsWindow.tsx`
- Modify: `packages/app/src/renderer/components/projects/ProjectsWindow.tsx`
- Modify: `packages/app/src/renderer/components/plan/PlanWindow.tsx`
- Delete: `packages/app/src/renderer/shared/TitleBar.tsx`
- Modify: `packages/app/src/renderer/shared/Panel.tsx`
- Modify: `packages/app/src/renderer/shared.css`

**Interfaces:**
- Consumes: nothing new.
- Produces: component windows render content directly under `bean-dashboard` (no in-app title bar); `PanelHeader` renders a clean centered title with no fake macOS traffic lights.

- [ ] **Step 1: Remove `TitleBar` from `PersonaWindow`**

In `PersonaWindow.tsx`, delete the `TitleBar` import and its JSX. The `theme` state is still needed to set `document.documentElement.dataset.theme`. Result:

```tsx
// packages/app/src/renderer/components/persona/PersonaWindow.tsx
import { useEffect, useState } from "preact/hooks";
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
      <div class="bean-single-column">
        <PersonaPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Remove `TitleBar` from `SkillsWindow`**

In `SkillsWindow.tsx`, delete the `TitleBar` import and JSX line. Result body:

```tsx
  return (
    <div class="bean-dashboard">
      <div class="bean-single-column">
        <SkillsPanel onRunSkill={onRunSkill} />
      </div>
    </div>
  );
```

Also remove the now-unused `import { TitleBar } from "../../shared/TitleBar.js";` line.

- [ ] **Step 3: Remove `TitleBar` from `ProjectsWindow`**

In `ProjectsWindow.tsx`, delete the `TitleBar` import and JSX line. Result body:

```tsx
  return (
    <div class="bean-dashboard">
      <div class="bean-single-column">
        <ProjectsPanel projects={projects} tasks={tasks} onLaunch={launchTask} onCancel={cancelTask} />
      </div>
    </div>
  );
```

- [ ] **Step 4: Remove `TitleBar` from `PlanWindow`**

In `PlanWindow.tsx`, delete the `TitleBar` import and JSX line. Result body:

```tsx
  return (
    <div class="bean-dashboard">
      <div class="bean-single-column">
        <div class="bean-plan-header">
          <span class="bean-plan-dot" />
          <span>Bean's plan · read from the link</span>
        </div>
        {run ? (
          <ProposalCard
            run={run}
            state={state}
            onConfirm={(edited) => {
              setState("confirmed");
              void window.bean.run({ ...run, composedPrompt: edited });
              void window.bean.openComponent("chat");
            }}
            onCancel={() => setState("cancelled")}
          />
        ) : (
          <div class="bean-panel-empty">Waiting for a plan…</div>
        )}
      </div>
    </div>
  );
```

- [ ] **Step 5: Delete `TitleBar.tsx` and confirm no references remain**

```bash
git rm packages/app/src/renderer/shared/TitleBar.tsx
```

Run: `grep -rn "TitleBar" packages/app/src`
Expected: no matches (empty output).

- [ ] **Step 6: Simplify `PanelHeader` (drop fake traffic lights)**

Replace the body of `packages/app/src/renderer/shared/Panel.tsx`:

```tsx
export function PanelHeader({ title }: { title: string }) {
  return (
    <div class="bean-panel-header">
      <span class="bean-panel-title">{title}</span>
    </div>
  );
}
```

- [ ] **Step 7: Remove dead CSS**

In `packages/app/src/renderer/shared.css`, delete these now-unused rule blocks:
- `.bean-titlebar`, `.bean-titlebar-dot`, `.bean-titlebar-name`, `.bean-titlebar-spacer`, `.bean-titlebar-orb`, `.bean-theme-toggle` (lines ~8–45).
- `.bean-panel-lights`, `.bean-panel-light`, `.bean-panel-light--red`, `.bean-panel-light--yellow`, `.bean-panel-light--green` (the traffic-light rules, ~lines 81–94).

Adjust `.bean-panel-title` so a centered title without the lights still reads well — it is already `position: absolute; left: 0; right: 0; text-align: center`, so it needs no change; leave `.bean-panel-header` as the header bar.

Confirm nothing else references the removed classes:

Run: `grep -rn "bean-titlebar\|bean-theme-toggle\|bean-panel-light" packages/app/src`
Expected: no matches.

- [ ] **Step 8: Build + typecheck**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app typecheck`
Expected: build succeeds; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/renderer/components packages/app/src/renderer/shared/Panel.tsx packages/app/src/renderer/shared.css
git commit -m "refactor(app): remove fake in-app titlebar and panel traffic lights"
```

---

### Task 8: Full-suite validation gate + memory update

**Files:**
- Create: `.memory/project-settings-about-context-menu.md`
- Modify: `.memory/INDEX.md`

- [ ] **Step 1: Run the full workspace gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 (all core + app tests pass; both packages typecheck clean).

- [ ] **Step 2: Add a team-memory entry**

Create `.memory/project-settings-about-context-menu.md`:

```markdown
# Settings / About / right-click menu

The avatar has a **right-click** context menu (`#bean-context` in avatar.html, wired in
avatar.ts) with **Settings · Persona · About**. It reuses the bubble-menu window-growth +
auto-fold machinery but with a tighter `AVATAR_CONTEXT_SIZE` (avatar-menu.ts) and its own
`"context"` `AvatarMode`. Persona was moved here — it is **no longer** a left-click quick action.

Settings edits `~/.bean/config.json` (openaiApiKey + model) via `saveConfig` (core) and
**live-reloads** the OpenAI clients through `runtime-config.ts` — no restart. `~/.bean` stays the
durable store (survives reinstalls); Settings also shows its paths read-only. The manual theme
toggle lives in Settings now (the old in-app `TitleBar` was removed).

Component windows (persona/skills/projects/plan/settings/about) render directly under
`bean-dashboard` with only native window chrome — no fake `TitleBar`, no fake macOS traffic
lights. Match this when adding new windows; the chat window is the reference.
```

- [ ] **Step 3: Link it from `.memory/INDEX.md`**

Under the `## project — ongoing work context` section of `.memory/INDEX.md`, add:

```markdown
- [project-settings-about-context-menu.md](project-settings-about-context-menu.md) — right-click menu (Settings/Persona/About), live-reloading Settings over ~/.bean, and the no-fake-chrome window rule.
```

- [ ] **Step 4: Commit**

```bash
git add .memory/project-settings-about-context-menu.md .memory/INDEX.md
git commit -m "docs(memory): record settings/about/context-menu conventions"
```

---

## Self-Review

**Spec coverage:**
- Right-click menu (Settings/Persona/About) → Task 6. ✓
- Settings edits `~/.bean/config.json`, live reload → Tasks 1, 2, 3, 4. ✓
- Settings shows read-only `~/.bean` paths → Task 3 (getConfig view) + Task 4 (render). ✓
- Persona moved from quick actions to right-click menu → Task 6 (removed from `QUICK_ACTIONS`, added to `CONTEXT_ACTIONS`). ✓
- About: dynamic version, description, author Scen.K, dynamic copyright year → Task 3 (`getAppInfo`) + Task 5. ✓
- Theme toggle moved into Settings → Task 4. ✓
- Chrome cleanup (remove fake TitleBar + traffic lights, match chat) → Task 7. ✓
- Tighter context-menu window size → Task 6 (`AVATAR_CONTEXT_SIZE = 360`). ✓
- Testing (core saveConfig round-trip, ipc handlers, runtime reload) → Tasks 1, 2, 3, 6, 8. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code steps include full code. ✓

**Type consistency:** `getModel: () => string` used consistently in `RouteHandlerDeps`/`ChatHandlerDeps` and provided by `runtime.getModel` in main.ts. `ConfigView`/`ConfigUpdate`/`AppInfo` defined once in `channels.ts` and imported by ipc.ts, preload.ts, bean.d.ts, and the components. `createRuntimeConfig` signature matches its usage in main.ts. `AVATAR_CONTEXT_SIZE` defined in avatar-menu.ts, consumed by `avatarSizeForMode` and the test. `CONTEXT_ACTIONS` kinds (`settings`/`persona`/`about`) are all valid `ComponentKind`s (added in Task 3). ✓
