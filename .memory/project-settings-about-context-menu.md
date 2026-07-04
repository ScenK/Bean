# Settings / Persona / About / Exit — tray-only, no right-click

Settings, Persona, About, and Exit live **only behind a left-click on the macOS tray icon**
(`main.ts`'s `tray.on("click", ...)` → `trayMenu`). There is **no right-click anywhere** —
not on the tray, not on the avatar. The avatar's own left-click quick-actions menu
(`QUICK_ACTIONS` in `renderer/avatar.ts`) is unrelated and only covers Chat/Skills/Projects/Notes.

Each tray item has a leading icon and (except About) a `⌘` accelerator, matching how `role: "quit"`
used to auto-decorate Exit before it was swapped for a plain `click` handler. Icons come from
`nativeImage.createMenuSymbol(sfSymbolName)` — an SF Symbol rendered natively for macOS menu
items, no PNG assets needed (macOS-only API; this app is macOS-only). Accelerators follow the
system App-menu convention: `⌘,` for Settings (preferences), `⌘Q` for Exit (quit), and **none**
for About — macOS's own About item never has one either, so don't add one "for consistency".

This is a deliberate simplification of an earlier design (see git history / the dated plan at
`docs/superpowers/plans/2026-07-01-bean-settings-about-context-menu.md`) that had a **right-click**
context card on the avatar body (`#bean-context`, a `"context"` `AvatarMode`) *and* a
matching tray right-click, mirrored so both surfaces behaved the same. That whole right-click
path — the `"context"` `AvatarMode`, `AVATAR_CONTEXT_SIZE`, `CONTEXT_ACTIONS`, `#bean-context`
markup/CSS, and the tray's `right-click` handler — was removed. Don't re-add a right-click
handler to the tray or the avatar body; if Settings/Persona/About need a second entry point,
add it as another left-click destination, not a right-click one.

Settings edits `~/.bean/config.json` (openaiApiKey + model) via `saveConfig` (core) and
**live-reloads** the OpenAI clients through `runtime-config.ts` — no restart. `runtime-config`
holds the clients behind *stable* `chat`/`converse` wrappers (identity never changes), and
`main.ts` passes those wrappers + `getModel()` into `registerIpc`, so handlers registered once
pick up new config. `apply()` builds the new clients **before** persisting, so a bad key can't
leave disk and memory inconsistent. `~/.bean` stays the durable store (survives reinstalls);
Settings also shows its paths read-only, and the manual theme toggle now lives in Settings (the
old in-app `TitleBar` was removed).

Component windows (persona/skills/projects/plan/settings/about) render directly under
`bean-dashboard` with only native window chrome — no fake `TitleBar`, no fake macOS traffic
lights. Match this when adding new windows; the chat window is the reference. New renderer
windows must be added to BOTH `esbuild.config.mjs`'s `entryPoints` AND its html-copy loop, plus
the `Record<ComponentKind, …>` maps in `windows.ts`.
