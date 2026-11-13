# The desktop shell runs on Windows as remote-only (#813)

Off macOS the shell has no local core (`core-store.ts` drops `"local"`, no "This Mac" row) and every
macOS-only call is guarded by `IS_MAC` in `main.ts` (or `process.platform === "darwin"` in a module):

- Tray: SF Symbols (`createMenuSymbol`) only on macOS; the template PNG is tinted bean orange
  (`tray-icon.ts`) since only macOS recolors template images. Accelerators are `CmdOrCtrl+…`.
- Windows: `hiddenInset` title bars and the Space hop are macOS-only; component windows set
  `autoHideMenuBar` so Windows doesn't show Electron's default menu bar. `setAppUserModelId(appId)` on
  win32 for toasts. Login items skip the `/Applications` check off macOS.
- Updater: self-install (ditto/codesign) is macOS-only — `AppInfo.selfUpdate`; elsewhere About shows
  only the releases link.
- Renderer shortcuts: use `renderer/shared/mod-key.ts` (`modKey(e)`, `MOD_KEY`, `MOD_LABEL`), never a
  bare `e.metaKey`, for anything reachable on a remote core. It reads the *shell's* OS from
  `navigator.platform`; the core's OS is `useCapabilities().platform`. The terminal pane keeps Cmd —
  pty is host-bound, so it never mounts on a remote-only shell, and Ctrl+T is readline's.
- `scripts/dev.mjs` spawns with `shell: true` on win32 (`pnpm` is a `.cmd` shim). Remote setup shows a
  PowerShell `ssh` key-install line instead of `ssh-copy-id` on Windows.
