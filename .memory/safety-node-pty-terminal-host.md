# node-pty: Bean's one native module, and how chat terminals die

`@bean/app` ships `node-pty` (chat terminals, `terminal-tasks.ts`) — the only native module, so it
breaks rules the rest of the app gets for free. All four of these are load-bearing:

- **`spawn-helper` must be executable.** node-pty 1.1.0's tarball ships
  `prebuilds/darwin-*/spawn-helper` as 0644; without +x every spawn fails `posix_spawnp failed`.
  `packages/app/scripts/pty-spawn-helper.mjs` chmods it twice: `postinstall` (dev `node_modules`)
  and electron-builder `afterPack` (inside `app.asar.unpacked`, before `afterSign` codesigns; it
  throws if no helper is found). node-pty looks for it in `app.asar.unpacked` itself.
- **Shipped, not bundled:** a real `dependencies` entry, esbuild `external`, `asarUnpack:
  node_modules/node-pty/**`. `allowBuilds: node-pty: false` — its install script would
  `node-gyp rebuild`; the N-API prebuilds already load under Electron. Same reason for
  `npmRebuild: false` in the electron-builder config (its rebuild also dies on `node-abi` not
  knowing a new Electron). No linux prebuild, so unit
  tests (CI is ubuntu) inject a fake `PtyFactory` and never load it.
- **Loaded lazily** (`createRequire` in main.ts's factory), so a broken native module fails one
  terminal's start, never app boot.
- **Kill:** interactive shells ignore SIGTERM — stop sends SIGHUP to the `killTree` snapshot (so
  `cmd &` jobs in their own groups die too) and escalates to SIGKILL. Exit paths: chat release
  (the window's `closed` releases every chat), `before-quit`, and the updater's relaunch hook
  (`app.relaunch()` skips before-quit; not on a rolled-back install). Every start re-checks the
  cwd with `projectAllowed` after its await; a refused/stale project opens the scratch workspace.

Verify packaged changes with a real `pnpm dist:mac` and spawn from inside `Bean.app`.
