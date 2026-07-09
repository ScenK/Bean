# safety: Tahoe parks the tray icon — keep the placement watchdog

**Symptom:** on macOS 26.5 (Tahoe) the bean tray icon never appears in the menu bar. The
`Tray` is created without error; `tray.getBounds()` reports an off-screen parking spot like
`{x:0, y:1150, width:32, height:22}` instead of real menu-bar bounds (`y:0`, `height:22`).
It looks code-caused but reproduces on `main` too — it's an OS regression (widely reported:
Stats #3120, Maccy #1224, BetterDisplay #5314, AeroSpace #1968).

**Mechanism (empirical, from minimal-repro bisecting):** menu-bar placement happens
asynchronously ~1–2s after `new Tray()`. Whether the item gets placed or parked depends on
what the app is doing at that instant — a floating (`alwaysOnTop`) window, an
activation-policy flip (`app.dock.hide()`), even an opaque window was enough; a bare tray-only
app placed fine. It's a race, not option semantics: don't try to fix it by reordering startup.

**Fix that works (in `main.ts`):** a placement watchdog. `makeTray()` builds the tray +
click handler; after creation, poll `tray.getBounds()` every 1.5s, and while it's parked
(`y !== 0 || height === 0`) destroy and recreate the tray (bounded at 5 retries). Recreation
reliably got placed on the next attempt even with the always-on-top avatar present. Don't
remove this loop when it "seems unnecessary" on a fixed macOS — it's inert when placement
succeeds first try.

**Also kept:** `app.dock?.hide()` runs *after* `makeTray()` — hiding the dock first parked
the item deterministically even pre-watchdog.

**Dev-only:** the packaged app is immune — `LSUIElement: true` (electron-builder
`build.mac.extendInfo`) makes it launch as an accessory app, so there's no runtime
activation-policy flip for the race to trip on and `dock.hide()` is a no-op. "Tray shows in
the packaged build but not under `pnpm dev`" is this bug, not a packaging problem.
