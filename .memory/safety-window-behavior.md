# safety: renderer window behavior — reuse, sizing, drag, lifecycle

The Electron windowing has several non-obvious behaviors. Don't "fix" them away.

**The avatar window never navigates.** Unlike the old avatar+intake single-window model,
`avatar.html` is loaded once and stays loaded for the app's lifetime — except that the tray's
**Bring Bean Back** reloads that same page (see "Bring Bean Back reloads" below). Double-click is
intentionally not wired on the bean body; component opens still call `window.bean.openComponent(kind,
droppedUrl?)` (IPC), which opens or focuses one of 4 separate singleton component
`BrowserWindow`s — it does not `location.href` the avatar window anywhere. There is no more
single "dashboard" window (retired in SP8).

**The avatar must stay no-drag where you click — and no-drag must be set on the element with
real geometry, not an ancestor.** The avatar window body is a `-webkit-app-region: drag` region
so you can move the pet around (also true while it's temporarily grown to show the bubble
menu). macOS treats a drag region as an OS window-move handle and **swallows mouse events**, so
any clickable element inside it must be `-webkit-app-region: no-drag` or its click/dblclick/drop
listeners never fire. This broke before for `#bean`, and bit the bubble menu twice during SP8:
first, the buttons had no `no-drag` at all (caught in task review, fixed by adding it to
`#bean-menu`, the buttons' zero-size (`width:0;height:0`) wrapper); that fix passed code review
but **still didn't work in real testing** — the buttons stayed unclickable until `no-drag` was
set directly on `.bean-bubble-btn` itself (each a real 68×68 `position:absolute` box). Don't
trust CSS-inheritance reasoning here: set `-webkit-app-region: no-drag` on the actual element
with the clickable box, not on an ancestor wrapper, however confident the cascade argument
seems — verify empirically (a code review alone missed this).

**Component windows do not respawn on close.** Like the old dashboard window, closing any of
the 4 component windows just clears its entry from `main.ts`'s `componentWindows` map; a later
`openComponent(kind)` call creates a fresh one. There is intentionally no auto-respawn.

**Cmd+W hides the avatar, it does not destroy it.** The avatar's `close` event is
intercepted in `main.ts` (`e.preventDefault(); avatar.hide()`) unless `quitting` is set, so
avatar.html stays loaded for the app's lifetime (see above) and the window keeps its bounds.
Re-summon a hidden bean by **clicking the tray icon** (`tray.on("click")` shows it when
hidden, else pops the menu). Don't revert this to a plain destroy: destroying it made
`openComponent`'s `avatar.getBounds()` throw `Object has been destroyed` when a tray menu item
(Settings/Persona/About) was clicked afterward, and left no way to get the pet back. A
belt-and-suspenders `avatar.isDestroyed()` guard also wraps that `getBounds()` call.

**Closing the avatar does not quit the app** (macOS-style); the app only quits on
`window-all-closed` off-darwin. Intentional.

**Theme state lives in `main.ts`, not per-window.** `getCurrentTheme`/`setCurrentTheme`
are closures over a single `currentTheme` variable in `main.ts`; every window's theme
follows the same `bean:theme-changed` broadcast. Don't give a window its own local theme
state — it'll drift from the others.

**The avatar now has a third grown size, for the drag-to-skill-bloom interaction.**
`AvatarMode` (`channels.ts`) is `"normal" | "hover" | "menu" | "drag"`; `avatar-menu.ts`'s
`nextAvatarBounds`/`avatarSizeForMode` generalize what used to be a menu-only boolean. The
same no-drag lesson above applies here too: the bloom's actual drop target
(`#bean-drag-bloom`) is one real, window-sized, no-drag element — the individual petals are
purely visual (`pointer-events: none`) and hit-tested by math, not by being separate DOM drop
targets, because a fragmented/zero-size target is exactly what broke the bubble menu buttons
before.

**A Plan window's "Run" hands off to Chat, it doesn't have its own console.** `runOpencode`'s
progress always streams to the Chat window's `webContents` (`ipc.ts`'s `IPC.run` handler
hardcodes `deps.chatSender()`), regardless of which window called `run()`. The Plan window
confirming a run also calls `openComponent("chat")` so the user sees the existing console
immediately, rather than growing a second, duplicate console view.

**Avatar visibility and edge placement (2026-09):** `avatar-window.ts` owns mode, original idle
anchor, cursor polling, native movement, and display recovery. Main loads the renderer only
after IPC registration (see project-e2e-ipc-ready-race.md). `dragBloomLayout` opens tile lists
above the capsule near the bottom edge and limits panel size to the work area. Scroll viewports
keep every skill reachable; drop hit-testing must include `scrollTop` and reject positions
outside the viewport. The capsule can shift inward at an edge so its text stays visible;
collapse returns to the original idle anchor, clamped to an available display.

All moves, including OS drag-region moves, update the anchor by the **applied** bounds delta.
The window is confined to one display's work area (no straddling). Display changes reset only
invalid bounds and never unhide a Cmd+W-hidden bean. Ordinary activation preserves placement;
the tray's explicit **Bring Bean Back** action resets onto the cursor's display. Reset must
clear renderer collapse/drag state before sending the new idle layout, including invalidating
pending asynchronous skill-list preparation. Keep the regression tests in avatar-window.test.ts
and avatar-visibility.e2e.ts.

**Chat remembers its size, not its position.** `windows.ts` reads `userData/chat-size.json`
synchronously (`chat-size-store.ts`) before building the chat `BrowserWindow`, clamps it to
440×520 and the anchor display's work area, then `nearAnchor` places it; the size is written
synchronously on `close`. Don't move this to renderer `localStorage` — the window exists before
any renderer does, so a renderer-held size makes it visibly jump. Guarded by
`chat-size-store.test.ts` and the chat-size spec in `component-windows.e2e.ts`.

**Bring Bean Back reloads the avatar page (#757).** A crashed/blank avatar renderer still
reports a URL and `isVisible() === true`, so moving + showing it does nothing — only
`webContents.reload()` repaints. `bringBack` resets main-side state (mode `normal`, status
height 0, cursor-display spot), reloads with `did-finish-load` / `did-fail-load` (main frame) /
`render-process-gone` / 10 s timeout listeners, then replays `taskStatus.list()`. While
`reloading`, the move/mode/status-height IPC is ignored (the old document still passes the
sender check) and main skips task-status pushes. Failure → non-blocking `showMessageBox`
(never `showErrorBox`: running work must keep going). The Space hop is
`setVisibleOnAllWorkspaces(true→false)` with `skipTransformProcessType: true` on **both** calls —
without it Electron flips the activation policy (the tray-parking trigger in
safety-tray-tahoe-placement.md). `reveal()` (tray click on a hidden bean, second launch, Dock)
does not reload. Evidence lines go to `~/.bean/logs/avatar.log` (allowlisted fields only; never
URLs/paths/task text). Known gap: the avatar can't be shown over a fullscreen app. No automatic
recovery — keep it click-only.
