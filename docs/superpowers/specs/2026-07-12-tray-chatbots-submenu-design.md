# Tray "Chat Bots" submenu — design

## Problem

The chatops (Discord/Teams) run/stop controls only live in the Settings window
(`SettingsWindow.tsx`'s "Chat bots" section). Reaching them requires opening
Settings first. We want a faster path: expose start/stop for both bots
directly from the tray, folded into a single new tray menu item so the
existing four-item tray menu (Settings/Persona/About/Exit) doesn't sprawl
into one row per bot.

## Design

Add one new top-level tray item, **"Chat Bots"**, as a `submenu`-type
`MenuItem`, inserted between `Settings` and `Persona` in the `trayMenu`
template in `main.ts`:

```
Settings
Chat Bots  ▸
   ☑ 🟢 Discord
   ☐ ⚪ Teams
Persona
About
Exit
```

Each bot is one `type: "checkbox"` menu item:

- `checked` reflects `chatopsServers.status()[bot].running`.
- The label is prefixed with a colored-dot character reflecting state:
  🟢 running, ⚪ stopped, 🔴 errored (`{dot} {Label}`, e.g. `"🟢 Discord"`).
  These are plain Unicode characters in the label string, not `icon:` —
  `nativeImage.createMenuSymbol` only renders monochrome template images
  (no tint parameter in Electron's API), so a colored indicator has to come
  from the label text, not the icon.
- If a bot has an `error` from its last exit, an extra **disabled**,
  non-checkbox menu item is appended directly below that bot's line showing
  the error text (mirrors `SettingsWindow.tsx`'s inline error message), with
  a 🔴 prefix. This line only appears when `error` is set.
- Clicking a bot's checkbox toggles it: if currently running, calls
  `chatopsServers.stop(bot)`; otherwise calls `chatopsServers.start(bot)`.
  This is the same `chatopsServers` object `main.ts` already constructs and
  wires into IPC for `SettingsWindow` — no new IPC channel is needed since
  the tray menu is built in the main process, where `chatopsServers` already
  lives in scope.

### Freshness

`chatopsServers.status()` is an in-memory, synchronous main-process read
(see `chatops-servers.ts`). Rather than subscribing to `chatopsServers`'s
event emitter to keep a long-lived `Menu` object in sync (extra
subscribe/rebuild bookkeeping for a menu that's invisible except in the
instant it's open), the whole `trayMenu` — including the `Chat Bots`
submenu — is rebuilt from current state each time right before
`tray.popUpContextMenu(...)` is called. This guarantees the checkbox/dot
state is accurate at the moment the user sees it, at the cost of trivial,
cheap-to-build Menu construction on every tray click (four/five items, no
measurable cost).

Concretely: `main.ts`'s existing `const trayMenu = Menu.buildFromTemplate([...])`
(built once, before `tray.on("click", ...)`) becomes a `buildTrayMenu()`
function, called both once at startup (kept as `tray`'s initial menu is
unused until the first click, so this is mostly for parity) and again inside
the `tray.on("click", ...)` handler immediately before
`tray.popUpContextMenu(trayMenu)`, reassigning the local `trayMenu` binding
each time.

### Scope / non-goals

- No new IPC channel, preload API, or renderer change — this is entirely
  within `main.ts` (plus reading the existing `chatopsServers` object it
  already owns).
- No change to `SettingsWindow.tsx`'s own Start/Stop UI — both surfaces
  independently call the same `chatopsServers.start/stop`, so they naturally
  stay in sync (each mutates the same in-memory `state`).
- Still no right-click anywhere (tray or avatar) — this is a left-click
  submenu, consistent with
  [`.memory/project-settings-about-context-menu.md`](../../../.memory/project-settings-about-context-menu.md).
- Doesn't address chatops `start()` failing when the bot dist isn't built or
  `~/.bean/{discord,teams}.json` is missing — that's existing behavior
  (surfaces as `error`), unchanged here; the new menu just displays it.

## Testing

- `@bean/core` is untouched (this is pure `@bean/app` main-process wiring),
  so no new core unit tests are needed.
- Manual/dev verification: `pnpm dev`, open the tray menu, confirm "Chat
  Bots" appears between Settings and Persona, toggle Discord/Teams from the
  tray and confirm the Settings window (if open) reflects the same
  running/stopped state and vice versa; confirm the dot/checkbox update on
  the next tray-menu open when a bot's process exits.
