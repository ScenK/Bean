# Bean — Dashboard Redesign, Sub-Project 1: Foundation — Design

Date: 2026-06-30
Status: Approved for planning
Source design: Claude Design "Bean Concept" (`Bean Concept.dc.html`, Turn 1 — Hearth/Graphite comparison)

## 1. Summary

Claude Design produced a mockup ("Bean Concept") reimagining Bean's UI as a single
persistent dashboard window — title bar, inline command bar, chat, console, skills
browser, persona panel, and a projects/subprocess launcher, all visible in one grid —
in two visual directions ("Hearth": warm/light/rounded, "Graphite": cool/dark/glassy).

Today's UI is minimal: a static-emoji avatar window, a plain-textarea intake window with
a `confirm()` dialog, and a raw `<pre>` console window (see
[2026-06-30-bean-desktop-pet-design.md](2026-06-30-bean-desktop-pet-design.md) for the
original MVP this replaces the UI layer of). This is a multi-session rebuild; this spec
covers only sub-project 1 of 6.

## 2. Full roadmap (context for future sessions)

Agreed decomposition and order, so later sessions don't need to re-derive it:

1. **Foundation** (this spec) — theme system, window model change, avatar/orb component, dashboard shell skeleton.
2. **Command bar + Chat panel** — inline route-preview/confirm + conversational view, wired to existing `route()`/`run()`.
3. **Console panel** — restyle the existing log stream to match the mockup.
4. **Skills panel** — browse/view/run `~/.bean/skills/*.md` skills; new read-oriented IPC.
5. **Persona panel** — name/tone/voice; new concept, not yet in `@bean/core` — its own design must resolve whether it's editable or decorative.
6. **Projects & Tasks panel** — project list + multi-launcher (`opencode run` / `claude -p` / `open` / `shell`) + live subprocess monitor. Biggest net-new scope; only one launch path exists today.

## 3. Decisions locked for this sub-project

| Decision | Choice |
|---|---|
| Window model | Floating avatar window persists as the idle presence (today's behavior, restyled). Double-click/drop opens a new `dashboard` window replacing `intake.html`/`console.html`. |
| Visual direction | Both Hearth and Graphite ship as a runtime-toggleable theme, not a single committed palette. |
| Renderer stack for dashboard | Preact (new dependency, dashboard only). Avatar window stays vanilla TS/DOM — it only needs the orb. |
| Theme persistence | Small JSON file under Electron's `userData` dir, owned entirely by `packages/app`. Not added to `@bean/core`'s `BeanConfig` — theme is a UI preference, not user-facing app config. |
| Theme sync | Main process holds current theme in memory, is the source of truth for `getTheme`/`setTheme`, and broadcasts `bean:theme-changed` to all open windows. |

## 4. Scope

**In scope:**
- Theme token system (CSS custom properties, `data-theme="hearth"|"graphite"` on `<html>`) covering both palettes from the mockup.
- Window model change: avatar window never navigates away from `avatar.html` again; opens `dashboard.html` via IPC instead of `location.href = "intake.html"`.
- New IPC/preload surface: `window.bean.getTheme()`, `window.bean.setTheme(t)`, `bean:theme-changed` broadcast, `window.bean.openDashboard(droppedUrl?)`.
- Shared orb component (`packages/app/src/renderer/orb.ts`): vanilla DOM+CSS, `createOrb(container, { size, palette }) -> { setState(s) }`, states `idle | listening | working | done`, theme-driven palette (not the mockup's hardcoded `palA`/`palB`).
- Dashboard shell: title bar (traffic lights, name, mini orb, "waiting" status, theme toggle, clock) + the mockup's 2-column grid with six placeholder panels (`CommandBarPanel`, `ChatPanel`, `ConsolePanel`, `SkillsPanel`, `PersonaPanel`, `ProjectsPanel`), each its own `.tsx` file with just a header + empty state.
- Delete `intake.html`/`intake.ts`, `console.html`/`console.ts` (superseded by the dashboard; their logic is ported into panels in sub-projects 2–3, not preserved as dead code).
- esbuild config updated for Preact JSX in the dashboard entry point only.

**Out of scope (deferred to sub-projects 2–6):** actual chat/skills/persona/projects panel logic and content, multi-launcher, subprocess monitor, orb state wiring to real routing/run events (this phase only requires `setState` to be callable and manually verified for all four states).

## 5. Architecture

### Windows
- **Avatar** (`avatar.html`) — unchanged transparent/draggable/always-on-top small window. Renders the orb in `idle` state. Click/drop now calls `window.bean.openDashboard(droppedUrl)` instead of navigating.
- **Dashboard** (`dashboard.html`, new) — Preact app. Opens on avatar interaction; focuses if already open. Hosts title bar + 6-panel grid.

### IPC additions (`packages/app/src/ipc.ts`, `preload.ts`)
- `bean:get-theme` → returns current theme from main-process memory (loaded from the `userData` JSON file at startup).
- `bean:set-theme` → updates memory + persists to file + broadcasts `bean:theme-changed` to every `BrowserWindow`.
- `bean:open-dashboard` → creates/focuses the dashboard window; passes `droppedUrl` through to it (replacing the current `sessionStorage` handoff, which only worked for same-window navigation).

### Orb component
- One module shared between the avatar window and the dashboard's title bar, parameterized by size and reading palette values from the active theme's CSS tokens rather than a hardcoded palette object, so a single implementation serves both themes.
- DOM structure and `@keyframes` ported near-verbatim from the mockup's `makeOrb`; the mockup's React-based construction becomes plain `document.createElement` calls, since state differences in the mockup are already expressed via CSS animation selection, not per-frame JS logic.

### Dashboard shell
- Root `<App>` (Preact): loads theme on mount, subscribes to `bean:theme-changed`, sets `data-theme`. Renders title bar + grid.
- Each of the 6 panels is its own file from the start so later sub-projects touch one file each without editing the shell.

## 6. Testing & rollout

- No new test-framework dependency — this repo has no DOM-testing infra today and this phase doesn't need one. Unit tests cover pure logic only: theme file read/write, the IPC handler wiring for get/set/broadcast (same isolation pattern as the existing `buildRouteHandler` split), and the orb's state-transition logic to the extent it's DOM-independent.
- Visual/behavioral correctness (both themes, orb motion in all 4 states, window open/close, drag, drop) is verified manually via `pnpm dev` after implementation, per this project's convention of testing UI changes in the running app rather than relying on type/test gates alone.
- `pnpm test && pnpm typecheck` must both pass before this sub-project is considered done.

## 7. Risks / open questions carried to later sub-projects

- Persona panel's edit-vs-decorative question (sub-project 5) isn't resolved yet — deferred deliberately since it doesn't affect the Foundation's shell/IPC/theme work.
- Projects & Tasks' multi-launcher (sub-project 6) needs new spawn/tracking logic beyond today's single `runOpencode` path — flagged for a dedicated design pass when that sub-project starts, not solved here.
