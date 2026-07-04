# safety: single-instance lock vs dev relaunch, and terminal signals

Bean holds `app.requestSingleInstanceLock()` (menu-bar app, `main.ts`). Three rules that
have already bitten:

- **`dev.mjs` must wait for the old Electron to exit before spawning the replacement.**
  Kill-then-spawn immediately makes the new instance see the lock as taken and `app.exit(0)`
  itself — leaving the *old* build running and every "my fix isn't working" symptom that
  implies. `launchElectron()` chains the respawn on the old child's `exit` event.
- **`main.ts` handles SIGINT/SIGTERM explicitly** (`app.quit()`). Electron does not reliably
  quit on terminal signals once it's a tray app with a hidden dock; without the handlers,
  Ctrl+C on `pnpm dev` orphans a Bean that keeps holding the lock.
- On lock failure use **`app.exit(0)`, not `app.quit()`** — quit is async, so `whenReady`
  still fires in the doomed duplicate and briefly creates a second tray/avatar.

Also: a long-running `pnpm dev` session serves the build from when its watcher last fired —
after main-process changes, verify against a freshly relaunched instance before concluding a
fix "doesn't work". `tray.getBounds()` is garbage for a title-only tray on macOS; use the
Accessibility position (`menu bar item 1 of menu bar 2`) if you need real coordinates.
