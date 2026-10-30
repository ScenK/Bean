# Resolved: avatar renderer must load after IPC registration

The avatar previously loaded as soon as its BrowserWindow was created, before async startup
completed and `registerIpc()` ran. Its first `getTheme()` or `openComponent()` could fail with
"No handler registered". Missing theme variables removed the SVG fill/glow and left a
transparent capsule with a black border on hover.

`createAvatarWindow()` now creates a hidden, unloaded window. Main calls
`loadAvatarWindow()` only after IPC is registered; loading completes before showing it.
The avatar HTML also supplies a theme fallback, and a failed theme request keeps that fallback.
Do not restore eager loading or move renderer startup ahead of handler registration.
Unrecoverable startup/load errors show an error and quit through normal cleanup rather than
leaving an invisible running instance; errors after a successful avatar load remain non-fatal.

Keep Playwright `workers: 1`: independent Electron launches can still contend. The startup
ordering fix alone is not evidence that parallel desktop tests are safe.

The reverse direction bites e2e specs too: a component window subscribes to main→renderer
pushes (`webContents.send`) in a React mount effect, after `domcontentloaded`. A spec that
pushes right after `waitForLoadState` loses the message on a slow CI runner (`ipcRenderer.on`
does not buffer), and an untimed `waitFor()` then hangs to the 30s test timeout. Wrap the
push + a short `waitFor` in `expect(...).toPass()` so it re-sends (see `contrast.e2e.ts`).

Two more CI-only races of the same shape (#520): component windows are `show: false` until
`ready-to-show`, so DOM being visible doesn't mean `BrowserWindow.isVisible()` is — poll it
before asserting on it (`chat-history.e2e.ts` `openChat`). And theme colors transition (the orb
body's `fill .3s`), so a contrast scan right after a theme flip reads a blended color — await
the document's `CSSTransition`s first (`contrast.e2e.ts` `setTheme`).
