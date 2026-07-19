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

**Update (2026-07-19, macOS 26.5.2/25F84) — solved case, different mechanism:** the tray
(packaged AND dev AND a minimal Electron repro) parked deterministically at `{x:0, y:1169}`
on one machine, surviving reboot and resets of `com.apple.controlcenter` /
`com.apple.systemuiserver` plists. Root cause was Tahoe's per-app **"Allow in the Menu Bar"**
gate (System Settings → Menu Bar), whose state lives in a TCC-protected plist that ordinary
pref resets do NOT touch:

    ~/Library/Group Containers/group.com.apple.controlcenter/Library/Preferences/group.com.apple.controlcenter.plist

It holds `trackedApplications` (`{isAllowed, menuItemLocations}` per app). An app gets
blocked either by its own `isAllowed = false` or by an **orphaned mapping** — a different,
disabled app's `menuItemLocations` claiming its bundle ID — and orphan-blocked apps don't
even appear in the Settings pane toggle list (upstream write-up: CodexBar issue #1440).
Fix: back up + delete that plist (or surgically flip the entry), `killall cfprefsd
ControlCenter`, relaunch Bean. Terminal needs Full Disk Access / "access data from other
apps" approval; sandboxed agents can't read it at all.

Confirmed culprit (decoded from the pre-fix backup): `com.openai.codex`'s entry was
`isAllowed = false` with `menuItemLocations = [com.openai.codex, dev.scenk.bean,
com.github.Electron]` — the tracker had filed Bean (and stock Electron) under the Codex
app's identity, almost certainly because **Bean spawns `codex exec` delegate children**,
and the disabled Codex toggle then blocked Bean transitively. This can re-form: if the
tray vanishes again on Tahoe, first check the Codex app's toggle in System Settings →
Menu Bar, then fall back to the plist reset. Decode the blob with
`plistlib.loads(outer["trackedApplications"])` — it's a nested binary plist.

After the reset Bean re-registered and shows its own toggle in the Settings pane despite
being only ad-hoc signed — signing is NOT required for the gate; a corrupt/orphaned entry
just hides the app from the pane while blocking it.

Diagnostic that cracked it: minimal native Swift `NSStatusItem` (unbundled CLI, untracked
by the gate) placed fine while every Electron tray parked — bundle-ID-keyed blocking, not
a rendering race. `tray.getBounds().y` far below the menu bar (≈ screen height) is the
"parked" signature in both this and the placement-race failure.
