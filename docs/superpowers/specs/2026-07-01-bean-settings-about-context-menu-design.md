# Bean — Right-click menu, Settings & About windows, chrome cleanup

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

## Goal

Give Bean a right-click context menu on the avatar body offering **Settings**, **Persona**,
and **About**. Add a Settings window (a GUI editor over `~/.bean/config.json`) and an About
window. Move Persona out of the left-click quick-actions bloom into the right-click menu. While
touching these windows, clean up the "subwindow-within-a-window" chrome so the component windows
match the already-cleaned chat window.

## Storage model (decided)

`~/.bean/` remains the durable store. It lives in `$HOME`, outside the app bundle, so it
survives reinstalls — this is *why* we keep it rather than moving config into Electron's
`userData`. Settings is a GUI editor over `~/.bean/config.json`; there is **no** migration or
fallback logic. Skills/projects/persona continue to live under `~/.bean/` and keep their own
windows — Settings only *displays* their paths (read-only).

## Non-goals

- No editing of skills/projects/persona files from Settings (they have their own windows).
- No config schema beyond the existing `{ openaiApiKey, model }`.
- No secure/encrypted key storage — this is a local desktop app; the key is shown in a
  password field prefilled from the file.

---

## 1. Right-click context menu (`avatar.ts`, `avatar.html`, CSS)

- Add a `contextmenu` listener on `#bean`: `e.preventDefault()`; when `mode === "normal"`, open
  a **custom styled vertical menu card** with three items: **Settings · Persona · About**.
  Selecting an item calls `window.bean.openComponent(kind)` and folds the menu.
- New avatar mode `"context"` (added to `AvatarMode`). It reuses the existing window-growth and
  auto-fold-on-cursor-leave machinery the bubble menu already uses, but with its **own tighter
  grow size** — the petal bloom's 600px window is far too large for a 3-item card:
  - Add `AVATAR_CONTEXT_SIZE` in `avatar-menu.ts` (≈ 320px, tuned during implementation to just
    fit the 3-item card without clipping). `avatarSizeForMode("context")` returns it. Growth is
    symmetric around the bean (via `nextAvatarBounds`), same as `"menu"`.
  - In `ipc.ts`, the `setAvatarMode` handler starts the fold poll for `"context"` as it already
    does for `"menu"` (treat both as "an open popup that should fold when the cursor leaves").
- New overlay element `#bean-context` in `avatar.html`, a small vertical card positioned near the
  bean center (the window grows symmetrically around the bean, so the center is
  `AVATAR_CONTEXT_SIZE / 2`). The card is a `-webkit-app-region: no-drag` element (per
  `.memory/safety-window-behavior.md`, popups must be real no-drag elements to receive clicks).
- Left-click bloom (`"menu"`) and right-click menu (`"context"`) are mutually exclusive: opening
  one closes the other; Escape and click-outside close either.
- **Remove `"persona"` from `QUICK_ACTIONS`** in `avatar.ts`. The left-click bloom becomes
  Chat · Skills · Projects; Persona now opens from the right-click menu.

## 2. Settings window

### Core (`@bean/core`)
- Add `saveConfig(file: string, config: { openaiApiKey: string; model: string }): Promise<void>`
  to `config.ts`, mirroring `savePersona`: `mkdir -p` the parent, then write
  `JSON.stringify({ openaiApiKey, model }, null, 2) + "\n"`. (Note: the on-disk file holds only
  `openaiApiKey` + `model`; `BeanConfig.beanDir` is a runtime-only field and is not written.)
- Exported automatically via the existing `export * from "./config.js"`.

### App wiring (`@bean/app`)
- `channels.ts`:
  - `ComponentKind` gains `"settings"` and `"about"`.
  - `AvatarMode` gains `"context"`.
  - `IPC` gains `getConfig`, `saveConfig`, `getAppInfo`.
- `windows.ts`: add size + title for `settings` (≈ 460×540) and `about` (≈ 420×360).
- `esbuild.config.mjs`: add renderer entry points
  `components/settings/index.tsx` and `components/about/index.tsx`; add `settings` and `about`
  to the html copy loop.
- New files: `renderer/settings.html`, `renderer/about.html` (mirror `persona.html`).
- `components/settings/`:
  - `SettingsWindow.tsx` — loads current config via `getConfig`; renders a form:
    - **OpenAI API Key** — password `<input>`, prefilled.
    - **Model name** — text `<input>`.
    - **Theme** — Hearth/Graphite toggle (see §5).
    - **Data location** — read-only list of the four `~/.bean` paths (config, skills, projects,
      persona), for orientation only.
    - **Save** button → `window.bean.saveConfig({ openaiApiKey, model })`; show inline
      success/error feedback.
  - `index.tsx` — renders `SettingsWindow` into `#root`.

### Live reload (no restart)
- `main.ts` holds a mutable `runtime = { cfg, chat, converse }` instead of passing fixed
  `chat`/`converse`/`model` into `registerIpc`.
- `registerIpc` receives **stable delegating wrappers** so handlers always call the current
  client:
  - `chat: (msgs) => runtime.chat(msgs)`
  - `converse: (msgs) => runtime.converse(msgs)`
  - `getModel: () => runtime.cfg.model` (replaces the fixed `model: string` dep)
  - `getConfig: () => ({ openaiApiKey, model, paths })` where `paths` are the four `~/.bean`
    file paths from `config.ts` helpers.
  - `saveConfig: (next) => Promise<void>` — implemented in `main.ts`: write via core
    `saveConfig(configFile(dir), next)`, then set `runtime.cfg = { ...next, beanDir: dir }`,
    `runtime.chat = makeOpenAIChat(next.openaiApiKey)`,
    `runtime.converse = makeOpenAIConverse(next.openaiApiKey)`.
- `buildRouteHandler`, `buildChatHandler`, and the `IPC.getModel` handler switch from
  `deps.model` to `deps.getModel()`.
- IPC registrations: `ipcMain.handle(IPC.getConfig, …)`, `ipcMain.handle(IPC.saveConfig, …)`.
- `preload.ts` + `bean.d.ts`: add `getConfig()`, `saveConfig(next)`, `getAppInfo()`.

## 3. About window

- `components/about/AboutWindow.tsx` shows:
  - **Version** via new `getAppInfo` IPC → `app.getVersion()` (reads `packages/app/package.json`
    version; **not** hardcoded).
  - A short static product description (one or two lines).
  - **Author: Scen.K**.
  - **© {new Date().getFullYear()} Scen.K** — year computed in the renderer, not hardcoded.
- `getAppInfo` IPC handler returns `{ version: app.getVersion(), author: "Scen.K",
  description: "<short blurb>" }`. Author/description may be constants; version must be dynamic.
- `index.tsx` renders `AboutWindow` into `#root`.

## 4. Chrome cleanup ("subwindows within the window")

**Problem:** the `persona` / `skills` / `projects` / `plan` windows render a fake in-app
`TitleBar` ("Bean · File · View · theme toggle") *plus* panels with fake macOS traffic-light
dots (`PanelHeader`), on top of the real native OS title bar. The chat window has neither and
reads cleanly.

**Changes:**
- Remove the `TitleBar` component from `PersonaWindow`, `SkillsWindow`, `ProjectsWindow`, and
  `PlanWindow`; render content directly inside `bean-dashboard` (as `ChatWindow` does).
- Delete `shared/TitleBar.tsx` (unused after the above) and its now-dead CSS
  (`.bean-titlebar*`, `.bean-theme-toggle`).
- Simplify `shared/Panel.tsx` `PanelHeader`: drop the fake macOS traffic-light dots
  (`bean-panel-lights` / `bean-panel-light*`), keep a clean minimal centered title. Remove the
  dead traffic-light CSS.
- Native window chrome (the real title bar, already `titleBarStyle: "default"` with a per-kind
  title from `COMPONENT_WINDOW_TITLE`) remains the only window chrome.

## 5. Theme toggle (decided: move into Settings)

The manual Hearth/Graphite toggle currently lives *only* in the `TitleBar` being deleted.
Rather than lose the manual override (theme otherwise silently follows the OS via the existing
`nativeTheme` sync in `main.ts`), move a small Hearth/Graphite toggle into the **Settings**
window. It calls the existing `window.bean.setTheme(...)`, which already broadcasts
`themeChanged` to every window. No new theme plumbing is required.

---

## Testing

- **Core (`@bean/core`, vitest):** `saveConfig` round-trips — after `saveConfig(file, cfg)`,
  `loadConfig(file, dir)` returns the same `openaiApiKey` + `model`. Verify only key+model are
  written (no `beanDir`).
- **App (`@bean/app`, vitest):** exercise the separable IPC handlers:
  - `getConfig` returns current key/model plus the four paths.
  - `saveConfig` writes the file and rebuilds the runtime (a subsequent `getModel()` reflects the
    new model; a fresh chat/converse client is constructed). Use injected fakes as existing
    `ipc.ts` tests do.
  - `getAppInfo` returns a version string, author, and description.
- **Gate:** `pnpm test && pnpm typecheck` both exit 0.

## Files touched (summary)

**Core:** `config.ts` (+`saveConfig`).
**App main/wiring:** `channels.ts`, `main.ts`, `ipc.ts`, `windows.ts`, `preload.ts`,
`renderer/bean.d.ts`, `esbuild.config.mjs`.
**Avatar:** `avatar-menu.ts` (+`AVATAR_CONTEXT_SIZE`), `renderer/avatar.ts`,
`renderer/avatar.html`, context-menu CSS (bubble-menu.css or a small addition).
**New windows:** `renderer/settings.html`, `renderer/about.html`,
`components/settings/{SettingsWindow,index}.tsx`, `components/about/{AboutWindow,index}.tsx`.
**Cleanup:** `components/{persona,skills,projects,plan}/*Window.tsx`, delete `shared/TitleBar.tsx`,
`shared/Panel.tsx`, `renderer/shared.css`.

## Memory / conventions to honor

- IPC channel names go in `channels.ts` only — never string-literalled
  (`.memory/convention-ipc-channels.md`).
- New IO stays in `@bean/core` as pure, dependency-injected functions
  (`.memory/convention-core-is-electron-free.md`); Electron wiring stays in `app/`.
- Avatar popups must be real, properly-sized `-webkit-app-region: no-drag` elements
  (`.memory/safety-window-behavior.md`).
- Preload stays CommonJS `.cjs` (`.memory/safety-preload-must-be-cjs.md`).
