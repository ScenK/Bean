# Configurable Terminal App — Design

**Status:** approved, ready for planning.

## 1. Purpose & scope

`launchInTerminal` (`packages/core/src/launcher.ts`) currently runs `opencode`/`claude` by
writing a `.command` script to `tmpdir()` and calling `open <script>` — this hands the script
to whatever app macOS has associated with `.command` files, which is Terminal.app on a stock
system with no way to override it from Bean. This SP adds a `terminalApp` setting so the user
can choose a different terminal emulator (iTerm, Warp, Ghostty, …).

**Mechanism:** macOS's `open -a "<App>" <file>` opens a file with a specific app instead of the
LaunchServices default. When `terminalApp` is set (a full path to an `.app` bundle, or a bare
app name resolvable via LaunchServices), `launchInTerminal` passes `-a <terminalApp>`; when
unset (`""`, the default), behavior is exactly what it is today. `"open"` mode (hardcoded to
`zed`) is unrelated — it spawns a GUI app directly, no terminal involved, and is untouched.

**Storage & lifecycle:** `terminalApp` is persisted in `~/.bean/config.json` alongside
`openaiApiKey`/`model`, follows the same "Settings save applies live, no restart" lifecycle via
`RuntimeConfig`, and is surfaced in the Settings window as a text field + native "Browse…" app
picker — the same pattern the Projects panel already uses for picking a project folder.

## 2. Core (`packages/core/src`)

**`types.ts`** — `BeanConfig` gains one field:
```ts
export interface BeanConfig {
  openaiApiKey: string;
  model: string;
  terminalApp: string; // "" = system default handler for .command files
  beanDir: string;
}
```

**`config.ts`** — `loadConfig` defaults `terminalApp` to `""` (same `??` pattern as `model`);
`saveConfig`'s `config`/`out` shape gains `terminalApp: string`.

**`launcher.ts`** — `launchInTerminal` gains a 4th, optional param:
```ts
export function launchInTerminal(
  req: LaunchRequest,
  spawnFn: LaunchSpawnFn = defaultSpawn,
  writeScript: ScriptWriter = defaultScriptWriter,
  terminalApp?: string,
): void {
  const { command, args } = launchCommand(req);
  if (req.mode === "open") { fireAndForget(spawnFn(command, args)); return; }
  const scriptPath = join(tmpdir(), `bean-run-${randomUUID()}.command`);
  const cmdLine = [command, ...args].map(shQuote).join(" ");
  writeScript(scriptPath, `#!/bin/sh\ncd ${shQuote(req.projectPath)}\n${cmdLine}\necho\necho "[bean] done — press Enter to close"\nread _\n`);
  const openArgs = terminalApp ? ["-a", terminalApp, scriptPath] : [scriptPath];
  fireAndForget(spawnFn("open", openArgs));
}
```
No validation that `terminalApp` names a real/compatible app — an incompatible choice surfaces
through the existing `fireAndForget` error log (e.g. `open`'s own "application not found" exit),
same as an unset `opencode`/`claude` on `PATH` does today.

## 3. App wiring

**`runtime-config.ts`** — `RuntimeConfig`/`RuntimeConfigDeps` extend the existing
apiKey/model pattern with a third plain value (no client to rebuild, just held state):
```ts
export interface RuntimeConfigDeps {
  makeChat: (apiKey: string) => RouterDeps["chat"];
  makeConverse: (apiKey: string) => ConverseDeps["chat"];
  saveConfigFile: (update: { openaiApiKey: string; model: string; terminalApp: string }) => Promise<void>;
}
export interface RuntimeConfig {
  // ...existing chat/converse/getModel/getApiKey/apply...
  getTerminalApp: () => string;
}
```
`createRuntimeConfig`'s `initial`/`apply` params and internal `apiKey`/`model` local-variable
pattern gain a parallel `terminalApp` local variable, set in the constructor and in `apply()`.

**`channels.ts`**:
```ts
export interface ConfigView {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
  paths: { config: string; skills: string; projects: string; persona: string };
}
export interface ConfigUpdate {
  openaiApiKey: string;
  model: string;
  terminalApp: string;
}
```
New IPC channel: `pickTerminalApp: "bean:pick-terminal-app"`.

**`ipc.ts`**:
- `LaunchHandlerDeps` gains `getTerminalApp?: () => string`; `buildLaunchHandler` passes it
  through: `launchInTerminal(req, deps.spawnLaunch, undefined, deps.getTerminalApp?.())`.
- `RegisterDeps` gains `getTerminalApp: () => string` (required at the `registerIpc` level,
  same as `getConfig`/`applyConfig`).
- New handler, mirroring `pickProjectFolder`'s shape:
  ```ts
  ipcMain.handle(IPC.pickTerminalApp, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openFile"] as const, filters: [{ name: "Applications", extensions: ["app"] }], defaultPath: "/Applications" };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ```

**`main.ts`** — `saveConfig(cfgPath, ...)` bootstrap default gains `terminalApp: ""`;
`createRuntimeConfig`'s initial value and `saveConfigFile` call pass `terminalApp`;
`registerIpc(...)` call gains `getConfig` returning `terminalApp: runtime.getTerminalApp()` in
its object, and a new `getTerminalApp: () => runtime.getTerminalApp()` entry.

**`preload.ts` / `bean.d.ts`** — add `pickTerminalApp(): Promise<string | undefined>` to the
`window.bean` bridge, same shape as `pickProjectFolder`.

## 4. Settings UI (`SettingsWindow.tsx`)

New field between MODEL NAME and THEME, matching the Projects panel's path-field + Browse…
pattern:
```tsx
<label class="bean-field">
  <span class="bean-field-label">TERMINAL APP</span>
  <div class="bean-path-row">
    <input
      class="bean-input"
      type="text"
      value={terminalApp}
      placeholder="System Default"
      onInput={(e) => { setTerminalApp((e.target as HTMLInputElement).value); setSave("idle"); }}
    />
    <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void browseTerminalApp()}>Browse…</button>
  </div>
</label>
```
`browseTerminalApp` calls `window.bean.pickTerminalApp()` and sets state if a path was chosen
(mirrors `ProjectsPanel.browsePath`). `onSave` includes `terminalApp: terminalApp.trim()` in the
`saveConfig` payload. `useEffect`'s `getConfig()` load sets `terminalApp` from `c.terminalApp`.

## 5. Testing plan

- **`packages/core/__test__/launcher.test.ts`** (extend): a case asserting
  `launchInTerminal(req, spawnFn, writeScript, "/Applications/iTerm.app")` calls
  `spawnFn("open", [written.path, ...])` → specifically
  `["-a", "/Applications/iTerm.app", written.path]`; a case confirming an unset/omitted
  `terminalApp` still calls `spawnFn("open", [written.path])` exactly as today (regression
  guard on the existing test at line 45).
- **`packages/app/__test__/runtime-config.test.ts`** (extend): `getTerminalApp()` reflects the
  initial value and updates after `apply()`, same shape as the existing model/apiKey coverage.
- **`packages/app/__test__/ipc.test.ts`** (extend): `buildLaunchHandler` forwards
  `getTerminalApp()`'s return value into `launchInTerminal`'s 4th arg (via a spy/fake), and the
  new `pickTerminalApp` handler returns `undefined` on cancel / the chosen path otherwise
  (mirrors existing `pickProjectFolder` coverage).
- **Settings UI**: no test framework for renderer UI (per repo convention) — verified manually
  via `pnpm dev`: open Settings, Browse… to an installed terminal app, Save, trigger an
  `opencode`/`claude` launch from Projects, confirm it opens in the chosen app; clear the field
  back to empty, Save, confirm launches revert to the system default.

## 6. Out of scope

- No curated dropdown of common terminal emulators — free-form path via native picker only.
- No validation/whitelisting of which apps are "real" terminal emulators.
- No change to the `"open"` (zed) launch mode.
- No cleanup of the existing temp `.command` file ponytail note in `launcher.ts` — unrelated to
  this change.
