# Bean — Dashboard Redesign, Sub-Project 8: Bubble Menu + Per-Component Windows — Design

Date: 2026-07-01
Status: Approved for planning
Depends on: SP1–SP7 (all six dashboard panels + the multi-launcher/task-monitor exist today under
one flat `dashboard` window)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Today, double-clicking the bean opens one `dashboard` `BrowserWindow` containing all 6 panels
(Command Bar, Chat, Console, Skills, Persona, Projects/Tasks) in a flat grid. This SP replaces
that with: double-click opens a stylized **bubble menu** around the bean (Chat / Skills /
Persona / Projects); picking a bubble opens-or-focuses that component's own dedicated,
persistent `BrowserWindow`. The single `dashboard` window and its flat panel grid are retired.
Component source code is reorganized from a flat `renderer/dashboard/panels/*` directory into
one folder per component under `renderer/components/`, so each can grow independently later.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Submenu presentation | A custom bubble menu rendered in the avatar's own window (not a native `Menu.popup`) — visual style is intentionally rough now, to be refined in a later pass. |
| Menu mechanism | The existing avatar `BrowserWindow` temporarily grows (`setBounds`, centered on its current position) to host the bean + 4 bubbles, then shrinks back — no second overlay window. |
| Bubble → target mapping | 4 bubbles: **Chat** (Command Bar + Chat + Console merged), **Skills**, **Persona**, **Projects** (Projects list + Task Monitor merged). Not a 1:1 mapping of today's 6 panels. |
| Window model | Each of the 4 components gets its own singleton `BrowserWindow`, reused/focused if already open — same reuse pattern `dashboard` already has today, just keyed per component instead of one variable. |
| Dropped-URL-on-bean | Opens/focuses **Chat** with that URL (replaces today's "opens dashboard with droppedUrl"). |
| Folder layout | `renderer/dashboard/` flat panels directory is retired in favor of `renderer/components/<name>/` (one per component) plus a `renderer/shared/` for cross-component pieces (TitleBar, Panel header, ProposalCard, chat/task types, format helpers). |
| CSS | Stays one shared stylesheet (renamed `dashboard.css` → `shared.css`) loaded by all 4 windows, same as today — splitting CSS per component is not worth the churn right now (deliberate scope trim; revisit only if a component's styles start fighting for the same class names). |
| Run/task event routing | `bean:run-event` now targets the **Chat** window specifically; `bean:task-event` targets the **Projects** window specifically (today both hit one hardcoded `sender`). This is real wiring work, called out explicitly so it isn't missed during planning. |
| Skills → Chat "Run skill" handoff | Today `SkillsPanel`'s "Run skill" pushes a `ProposalCard` straight into the same window's chat feed. Now that Skills and Chat are separate windows, clicking "Run skill" sends a new `IPC.proposeRun(suggestion)` that (a) calls `openComponent("chat")` and (b) is received by the Chat window and turned into a `ProposalCard`, same as any other proposal. |

## 3. Scope

**In scope:**
- Avatar window (`avatar.ts`/`avatar.html`): bubble-menu open/close state, bubble layout/CSS,
  dblclick now toggles the menu instead of opening a window directly, drag-to-move disabled
  while the menu is open, click-outside/Escape closes the menu.
- New `IPC.setAvatarMenuOpen` channel + main-process handler that grows/shrinks the avatar
  `BrowserWindow` via `setBounds`, centered on its current position.
- New `IPC.openComponent({ kind, droppedUrl? })` channel replacing `IPC.openDashboard`; new
  `ComponentKind` type (`"chat" | "skills" | "persona" | "projects"`) in `channels.ts`.
- New `IPC.proposeRun(suggestion: RouteSuggestion)` channel: `SkillsWindow` sends it (and calls
  `openComponent("chat")`) when the user clicks "Run skill"; `ChatWindow` listens for it and
  appends a `ProposalCard` exactly like `runSkillProposal` does today.
- `windows.ts`: `createComponentWindow(kind)` replaces `createDashboardWindow`.
- `main.ts`: `Map<ComponentKind, BrowserWindow>` replaces the single `dashboardWin` variable;
  `openComponent(kind, droppedUrl?)` replaces `openDashboard`; `chatSender`/`projectsSender`
  accessors replace the single `sender` accessor for run-event/task-event routing.
- Full renderer restructure: `renderer/dashboard/**` → `renderer/shared/**` +
  `renderer/components/{chat,skills,persona,projects}/**`, with one HTML entry file per
  component at the renderer root (`chat.html`, `skills.html`, `persona.html`, `projects.html`,
  replacing `dashboard.html`) and matching esbuild entry points.
- `dashboard.css` → `shared.css` (rename only, contents unchanged).

**Out of scope (unchanged, not touched by this SP):**
- Any panel's internal behavior/logic (Chat's proposal flow, Skills' edit flow, Persona's tag
  editor, Projects' launcher/task monitor) — this SP only moves files and changes how windows
  are opened, not what's inside them.
- Bubble menu's final visual polish — explicitly deferred by the user to a follow-up styling
  pass. This SP ships a real, working, but visually rough bubble layout.
- Any new `@bean/core` logic — no core changes needed.

## 4. Architecture

### 4.1 `channels.ts`

```ts
export type ComponentKind = "chat" | "skills" | "persona" | "projects";

export const IPC = {
  // ...unchanged entries...
  openComponent: "bean:open-component",       // replaces openDashboard
  componentDroppedUrl: "bean:component-dropped-url", // replaces dashboardDroppedUrl
  setAvatarMenuOpen: "bean:set-avatar-menu-open",    // new
} as const;
```

### 4.2 `windows.ts`

```ts
export function createComponentWindow(kind: ComponentKind): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040, height: 720,
    webPreferences: { preload },
  });
  void win.loadFile(renderer(kind));
  return win;
}
```
`createAvatarWindow` is unchanged except it's still the one window `setAvatarMenuOpen` resizes.

### 4.3 `main.ts`

```ts
const componentWindows = new Map<ComponentKind, BrowserWindow>();

const openComponent = (kind: ComponentKind, droppedUrl?: string): void => {
  const existing = componentWindows.get(kind);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    if (droppedUrl && kind === "chat") existing.webContents.send(IPC.componentDroppedUrl, droppedUrl);
    return;
  }
  const win = createComponentWindow(kind);
  componentWindows.set(kind, win);
  win.on("closed", () => { componentWindows.delete(kind); });
  if (droppedUrl && kind === "chat") {
    win.webContents.once("did-finish-load", () => win.webContents.send(IPC.componentDroppedUrl, droppedUrl));
  }
};

let avatarMenuOpen = false;
const AVATAR_MENU_SIZE = 300; // px, square
const AVATAR_SIZE = 120;
const AVATAR_MENU_INSET = (AVATAR_MENU_SIZE - AVATAR_SIZE) / 2;
```
`registerIpc` gains:
```ts
ipcMain.on(IPC.setAvatarMenuOpen, (e, open: boolean) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || open === avatarMenuOpen) return;
  avatarMenuOpen = open;
  const b = win.getBounds();
  const delta = open ? AVATAR_MENU_INSET : -AVATAR_MENU_INSET;
  const size = open ? AVATAR_MENU_SIZE : AVATAR_SIZE;
  win.setBounds({ x: b.x - delta, y: b.y - delta, width: size, height: size });
});
```
(`avatarMenuOpen`/the size constants live in `main.ts` next to the `openComponent` map, passed
into `registerIpc`'s deps the same way `openDashboard` is today — exact deps shape is a plan-time
detail, not re-litigated here.)

`RegisterDeps.sender` (single getter) is replaced with:
```ts
chatSender: () => WebContents | undefined;
projectsSender: () => WebContents | undefined;
```
wired in `main.ts` as `() => componentWindows.get("chat")?.webContents` /
`() => componentWindows.get("projects")?.webContents`. `ipc.ts`'s `IPC.run` handler sends
`runEvent` via `chatSender()`; `buildLaunchHandlers`'s `taskEvent` send uses `projectsSender()`.

### 4.4 Avatar bubble menu (`avatar.ts` / `avatar.html`)

`avatar.html` gains a menu container sibling to `#bean`:
```html
<div id="bean">…</div>
<div id="bean-menu" class="bean-menu">
  <button type="button" class="bean-bubble-btn" data-kind="chat">Chat</button>
  <button type="button" class="bean-bubble-btn" data-kind="skills">Skills</button>
  <button type="button" class="bean-bubble-btn" data-kind="persona">Persona</button>
  <button type="button" class="bean-bubble-btn" data-kind="projects">Projects</button>
</div>
```
CSS (new file `bubble-menu.css`, loaded by `avatar.html`): `.bean-menu` is absolutely positioned,
centered over `#bean`, `opacity: 0; pointer-events: none;` by default; `.bean-menu--open` fades
it in (`opacity: 1; pointer-events: auto;`) with a short transition. Each `.bean-bubble-btn` is
placed at a fixed offset (N/E/S/W around the bean — simplest first pass, no trig needed for 4
items) via `transform: translate(x, y)`.

`avatar.ts` changes:
- Track `let menuOpen = false;`.
- `dblclick` on `#bean` now calls a `toggleMenu()` that flips `menuOpen`, toggles the
  `bean-menu--open` class, and calls `window.bean.setAvatarMenuOpen(menuOpen)`.
- Each `.bean-bubble-btn` click: `window.bean.openComponent(btn.dataset.kind); closeMenu();`.
- A `window` click listener (only while `menuOpen`) that closes the menu when the click target
  is neither `#bean` nor a bubble button (click-outside-to-dismiss); `keydown` Escape does the
  same.
- The existing mousedown/mousemove drag-to-move listeners (tweak #1) gain an early return when
  `menuOpen` is true, so the grown window can't be dragged mid-pick.
- `drop` handler now calls `window.bean.openComponent("chat", url)` instead of
  `window.bean.openDashboard(url)`.

### 4.5 Renderer folder restructure

```
renderer/
  shared/
    TitleBar.tsx        (was dashboard/TitleBar.tsx)
    Panel.tsx            (was dashboard/Panel.tsx)
    ProposalCard.tsx      (was dashboard/ProposalCard.tsx)
    chat-types.ts         (was dashboard/chat-types.ts)
    task-types.ts         (was dashboard/task-types.ts)
    format.ts             (was dashboard/format.ts)
  components/
    chat/
      index.tsx           (bootstrap: render(<ChatWindow/>, root) — was dashboard.tsx)
      ChatWindow.tsx       (shell: TitleBar + CommandBarPanel + ChatPanel + ConsolePanel + all
                            the chat/run state currently in App.tsx — theme, items, busy,
                            activity, currentRun, terminal, runStatus, startedAt, droppedUrl,
                            sendMessage/confirmProposal/cancelProposal, onRunEvent wiring)
      ChatPanel.tsx
      CommandBarPanel.tsx
      ConsolePanel.tsx
    skills/
      index.tsx
      SkillsWindow.tsx     (shell: TitleBar + SkillsPanel; "Run skill" now calls
                            `openComponent("chat")` then sends `IPC.proposeRun(suggestion)`
                            instead of pushing directly into a shared chat item list)
      SkillsPanel.tsx
    persona/
      index.tsx
      PersonaWindow.tsx    (shell: TitleBar + PersonaPanel)
      PersonaPanel.tsx
    projects/
      index.tsx
      ProjectsWindow.tsx   (shell: TitleBar + ProjectsPanel; owns tasks/launchTask/cancelTask
                            state and onTaskEvent wiring, currently in App.tsx)
      ProjectsPanel.tsx
      TaskMonitor.tsx
  chat.html / skills.html / persona.html / projects.html   (flat, like avatar.html — replace dashboard.html)
  shared.css   (renamed from dashboard.css, contents unchanged)
```
Each `<X>Window.tsx` owns its own `useState<Theme>` + `getTheme`/`onThemeChanged` wiring
(duplicated 4x, same handful of lines `App.tsx` already had) — no shared theme hook is
introduced; this is a deliberate YAGNI trim, revisit only if the duplication actually becomes
annoying.

`esbuild.config.mjs`: `entryPoints` becomes
`["src/renderer/avatar.ts", "src/renderer/components/chat/index.tsx", ".../skills/index.tsx",
".../persona/index.tsx", ".../projects/index.tsx"]`; the static-copy list swaps `dashboard.html`
for the 4 new HTML files and `dashboard.css` for `shared.css`.

## 5. Error handling

- `setAvatarMenuOpen` IPC: no-ops if the sender's window can't be resolved (shouldn't happen —
  only the avatar window calls it) or if the requested state matches the current state (avoids
  double-grow/shrink from a duplicate event).
- Component window creation failures: same as today — none expected in practice (`loadFile` on
  a bundled asset), no new try/catch beyond what `createDashboardWindow` already didn't have.
- Closing a component window just drops its map entry (same as today's single `dashboardWin`
  behavior) — no respawn, no app-quit, consistent with `.memory/safety-window-behavior.md`.

## 6. Testing

No new test framework. Any new pure logic worth a unit test (e.g. the bounds-delta math for
`setAvatarMenuOpen`, if it's factored into a small testable function rather than inlined) gets
one, following the existing `@bean/core`/`ipc.ts` style. Renderer/visual behavior (bubble
menu open/close, drag-disabled-while-open, per-window content) is verified manually via
`pnpm dev`.

**Gate:** `pnpm test && pnpm typecheck` from the repo root, both exit 0.

## 7. Manual verification checklist (for the plan's final task)

- Double-click the bean → 4 bubbles fade in around it; the avatar window visibly grows,
  centered on the bean's prior position (doesn't jump to a corner).
- Click each bubble once → its window opens; click the same bubble again while that window is
  already open → it focuses the existing window instead of opening a second one.
- Click empty space in the grown avatar window (not the bean, not a bubble) → menu closes, no
  window opens. Press Escape with the menu open → same.
- Double-click the bean again while the menu is open → menu closes (toggle-off).
- While the menu is open, try to drag the bean → it does not move (drag disabled while
  menu is open).
- Drop a URL on the bean → the Chat window opens/focuses with that URL available (replacing
  today's dashboard-with-droppedUrl behavior).
- Toggle Hearth/Graphite in any one component window → confirm the other 3 (already open)
  restyle too, same as today's cross-window theme broadcast.
- Trigger a chat-confirmed run → its stdout/stderr/status appears in the Chat window's Console
  section live. Launch a project task from the Projects window → its status/progress updates
  live there. (Confirms the run-event/task-event re-routing in §4.3 actually reaches the right
  window.)

## 8. Risks / open questions

- **Bubble menu visual polish is intentionally rough** — 4 fixed N/E/S/W offsets, no animation
  beyond a fade, no hover states beyond default button styling. Confirmed acceptable by the user
  as a separate follow-up styling pass, not blocking this SP.
- **Avatar window growing via `setBounds` while `resizable: false`:** confirmed this is standard
  Electron behavior (the flag only blocks *user*-driven resize handles, not programmatic
  `setBounds`/`setSize`) — not re-verified with a running app in this design pass; the plan's
  manual-verification task is the first real confirmation.
- **`IPC.proposeRun` while Chat isn't open yet:** `openComponent("chat")` creates the window
  and its renderer needs a beat to load before it can receive `proposeRun`. Same pattern already
  exists for `componentDroppedUrl` (§4.3's `did-finish-load` handling) — the plan should apply
  the identical fix (queue-until-loaded via `did-finish-load`) to `proposeRun`, not just to
  dropped URLs.
