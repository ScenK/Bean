# E2E: openComponent race before IPC handlers are registered

`main.ts`'s `app.whenReady()` handler creates and shows the avatar window
(`createAvatarWindow()`) immediately, but `registerIpc(ipcMain, {...})` — which wires up
`bean:open-component` and every other channel — doesn't run until after config/tray/theme
setup completes further down the same async function. If the avatar's renderer loads fast
enough to call `window.bean.openComponent(...)` before that later `registerIpc()` call has
executed, the real error surfaces: `Error invoking remote method 'bean:open-component': Error:
No handler registered for 'bean:open-component'`.

This is a **pre-existing app startup race**, not something introduced by the Electron E2E
suite (`packages/app/e2e/`) — it reproduces at roughly the same rate on unmodified code. The
e2e suite just makes it visible because it calls `openComponent` immediately after launch, back
to back, repeatedly, far more aggressively than a human clicking through the UI ever would.

**Current mitigation:** none in the app itself. The `e2e` CI job (`.github/workflows/ci.yml`)
is advisory (not a required branch-protection check — see `AGENTS.md`), so an occasional flake
from this race doesn't block merges.

**Fast-follow if this proves disruptive:** either (a) have the e2e fixtures poll for
`window.bean` readiness before calling `openComponent` (test-side workaround, doesn't touch
production code), or (b) move `registerIpc()` before `createAvatarWindow()` in `main.ts` (fixes
the actual race for real users too, not just tests — the more correct fix, but touches app
startup ordering, so verify nothing in `registerIpc`'s deps assumes the window already exists).
