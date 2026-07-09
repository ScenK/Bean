# safety: Tahoe can park the tray icon off-screen in dev runs

**Symptom:** under `pnpm dev` on macOS 26.5 (Tahoe) the bean tray icon may never appear in
the menu bar. The `Tray` is created without error; `tray.getBounds()` reports an off-screen
parking spot like `{x:0, y:1150, width:32, height:22}` instead of real menu-bar bounds
(`y:0`). **Packaged builds are immune** — `LSUIElement: true` (electron-builder
`build.mac.extendInfo`) launches them as accessory apps, so there's no runtime state churn
for the race to trip on. "Tray shows in the packaged build but not under `pnpm dev`" is this
OS bug, not a packaging problem.

**Mechanism (empirical, from minimal-repro bisecting):** Tahoe places menu-bar status items
asynchronously, ~1–2s after `new Tray()`, and whether the item is placed or parked depends
on what the app is doing at that instant — flipping activation policy (`app.dock.hide()`),
owning a floating (`alwaysOnTop`) or even plain window all parked it, combination-dependent
and racy. It's an OS regression hitting many menu-bar apps (Stats #3120, Maccy #1224,
BetterDisplay #5314, AeroSpace #1968).

**Decision: no workaround loop.** A destroy-and-recreate watchdog was tried and did NOT
reliably fix dev runs on real hardware; it was removed rather than shipped as a fragile hack.
We wait for the Apple/Electron fix. What `main.ts` keeps instead:

- `app.dock?.hide()` runs only when `app.isPackaged` (where LSUIElement makes it a no-op
  anyway) — dev keeps its Dock icon, avoiding the activation-policy flip that parked the
  item deterministically in testing.
- The Dock icon doubles as the dev re-summon path: an `app.on("activate")` handler shows a
  Cmd+W-hidden avatar, so a missing tray icon never strands the pet (tray click does the
  same when the icon does appear).

Don't reintroduce a placement-retry loop without re-testing on current macOS.
