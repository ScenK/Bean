# Bean — Drag URL → Skill Bloom → Plan Window — Design

Date: 2026-07-01
Status: Approved for planning
Source mockup: `~/Downloads/Desktop AI Pet Helper Design/Bean Interaction.standalone.html`
  (dark-only demo; both themes ship here via the existing `--bean-*` CSS variables)

## 1. Summary

Today, dropping a URL onto the bean immediately opens the Chat window with the URL attached;
the user still has to type an instruction before anything happens. This adds the mockup's
richer interaction: dragging a URL onto the bean blooms a radial fan of skill petals around
it; the user keeps dragging and releases over the skill they want; Bean composes a plan
(skill + project + instruction) with no typing required, and shows it in a new, standalone
**Plan** window with Run / Cancel. Releasing without landing on a petal (or no skills
configured at all) falls back to today's exact behavior.

This reuses more than it builds: the window-grow trick from the bubble menu
(`avatar-menu.ts`), the existing `ProposalCard` (chips + editable prompt + confirm/cancel),
the existing `TitleBar`, the existing per-kind component-window pattern, and the existing
`--bean-*` theme tokens (which already numerically match the mockup's dark palette).

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Where the plan appears | Its own new component window (`"plan"` kind), not an overlay on the avatar. Visually follows the mockup's card chrome, but reuses the existing `ProposalCard` for the actual chips/prompt/buttons — no parallel run-wiring. |
| Fabricated numbered steps | Skipped. The mockup's 3-step breakdown is hand-written demo content standing in for a "Bean actually read and understood the page" pipeline that doesn't exist yet (would mean fetching the URL and summarizing it — new scope, not designed here). The Plan window shows the single composed instruction instead, same as chat's proposal cards today. |
| Best-guess petal | Hardcoded heuristic, no model call: whichever skill matches some project's `defaultSkill`, else the first skill. Explicitly a stand-in ( `ponytail`-flagged) for real suggestion logic later. |
| Project inference on drop | Same philosophy — no model call. `planForDroppedSkill` picks the project whose `defaultSkill` matches the dropped skill, else the first project. |
| Replace vs. sit alongside old behavior | Replace, with a no-pick fallback: dropping with no skills configured, or releasing outside every petal, opens Chat with the URL attached exactly as today. |
| "Reading…" delay | A fixed, deliberately fake ~700ms delay (mirrors the mockup's own `setTimeout`) — no real fetch happens yet. |
| Interaction mechanics | One continuous native OS drag (not two separate gestures): `dragenter` blooms, `dragover` tracks/highlights the nearest petal, `drop` commits. |

## 3. Scope

**In scope:**
- Avatar renderer: skill-bloom drag interaction (grow window, render petals, live hover
  highlight, commit on drop, fallback on miss).
- Core: `planForDroppedSkill()` — pure, no-LLM plan composition for a forced skill.
- App: new `"plan"` component window (compact size, own IPC delivery, reuses
  `ProposalCard`/`TitleBar`).
- Generalizing the avatar's window-bounds/mode plumbing (`avatar-menu.ts`,
  `bean:set-avatar-menu-open`) from a 2-state boolean (menu open/closed) to a 3-state mode
  (`normal` / `menu` / `drag`), since the bloom needs a third grown size.

**Out of scope (explicitly deferred):**
- Any real "fetch the URL + understand the page + break into steps" pipeline. The
  "reading…" pill and the Plan window's content are both stubs today.
- A real model-driven best-guess petal or project inference.
- Pagination/wrapping if a user configures a very large number of skills (bloom just spreads
  them evenly across a fixed arc; see §8).

## 4. Architecture

### 4.1 Core: `planForDroppedSkill` (`packages/core/src/drop-plan.ts`)

Pure function, mirrors `route()`'s shape but takes the skill as a given (the user already
chose it by dropping) instead of asking a model to pick one.

```ts
import { composePrompt } from "./prompt.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";

// ponytail: naive project match, no model call — same "hardcode it, revisit the real
// inference later" call made for the avatar's best-guess petal badge (see drag-bloom spec).
export function planForDroppedSkill(
  skillName: string,
  droppedUrl: string,
  skills: Skill[],
  projects: Project[],
): RouteSuggestion {
  const skill = skills.find((s) => s.name === skillName);
  const project = projects.find((p) => p.defaultSkill === skillName) ?? projects[0];
  return {
    skillName: skill?.name ?? skillName,
    projectPath: project?.path ?? "",
    composedPrompt: skill ? composePrompt(skill, "Handle the linked page.", droppedUrl) : droppedUrl,
    confidence: 0,
  };
}
```

Exported from `packages/core/src/index.ts` alongside `route`/`converse`.

### 4.2 Channels (`packages/app/src/channels.ts`)

```ts
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "plan";
export type AvatarMode = "normal" | "menu" | "drag";

export const IPC = {
  // ...existing entries unchanged...
  setAvatarMode: "bean:set-avatar-mode",   // replaces setAvatarMenuOpen
  planFromDrop: "bean:plan-from-drop",     // new
} as const;
```

`setAvatarMenuOpen` is removed — `setAvatarMode` generalizes it to 3 states.

### 4.3 Avatar bounds (`packages/app/src/avatar-menu.ts`)

Generalized from a boolean open/close to an arbitrary target size, so it serves all 3 modes
without a per-mode branch:

```ts
export const AVATAR_SIZE = 120;
export const AVATAR_MENU_SIZE = 300;
export const AVATAR_DRAG_SIZE = 440;

export interface Bounds { x: number; y: number; width: number; height: number; }

export function nextAvatarBounds(current: Bounds, targetSize: number): Bounds {
  const delta = (targetSize - current.width) / 2;
  return { x: current.x - delta, y: current.y - delta, width: targetSize, height: targetSize };
}

export function avatarSizeForMode(mode: AvatarMode): number {
  if (mode === "menu") return AVATAR_MENU_SIZE;
  if (mode === "drag") return AVATAR_DRAG_SIZE;
  return AVATAR_SIZE;
}
```

`nextAvatarBounds`'s existing tests get rewritten for the new numeric-size signature (grow
120→300, shrink 300→120, plus a new 120→440 drag-size case) — same idea, generalized.

### 4.4 IPC (`packages/app/src/ipc.ts`, `packages/app/src/main.ts`)

`ipc.ts`: one bounds handler replaces the old boolean one (drops the `avatarMenuOpen`
closure variable entirely — `setBounds` to an already-current size is a harmless no-op, so
there's nothing to track):

```ts
ipcMain.on(IPC.setAvatarMode, (e, mode: AvatarMode) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.setBounds(nextAvatarBounds(win.getBounds(), avatarSizeForMode(mode)));
});
```

New `planFromDrop` dependency, wired the same way `proposeRun` already is:

```ts
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  // ...existing...
  planFromDrop: (skillName: string, droppedUrl: string) => void;
}
// in registerIpc():
ipcMain.on(IPC.planFromDrop, (_e, skillName: string, droppedUrl: string) => deps.planFromDrop(skillName, droppedUrl));
```

`main.ts` implements it using the same `loadSkills`/`loadProjects`/`sendWhenReady`/
`componentWindows`/`openComponent` machinery `proposeRun` already uses — it just targets the
new `"plan"` kind instead of hardcoding `"chat"`, and reuses the *existing*
`IPC.proposeRun` push/listen pair to deliver the payload (no new delivery channel):

```ts
const planFromDrop = (skillName: string, droppedUrl: string): void => {
  void (async () => {
    const [skills, projects] = await Promise.all([
      loadSkills(skillsDir(dir)),
      loadProjects(projectsFile(dir)),
    ]);
    const suggestion = planForDroppedSkill(skillName, droppedUrl, skills, projects);
    openComponent("plan");
    sendWhenReady(componentWindows.get("plan")!, IPC.proposeRun, suggestion);
  })();
};
// ...pass `planFromDrop` into registerIpc(ipcMain, { ..., planFromDrop })
```

### 4.5 Component window sizing (`packages/app/src/windows.ts`)

All 4 existing component kinds share one 1040×720 size; the Plan window is a compact card,
not a dashboard, so this adds a per-kind lookup:

```ts
const COMPONENT_WINDOW_SIZE: Record<ComponentKind, { width: number; height: number }> = {
  chat: { width: 1040, height: 720 },
  skills: { width: 1040, height: 720 },
  persona: { width: 1040, height: 720 },
  projects: { width: 1040, height: 720 },
  plan: { width: 480, height: 460 },
};

export function createComponentWindow(kind: ComponentKind): BrowserWindow {
  const { width, height } = COMPONENT_WINDOW_SIZE[kind];
  const win = new BrowserWindow({ width, height, webPreferences: { preload } });
  void win.loadFile(renderer(kind));
  return win;
}
```

### 4.6 Preload / renderer types (`preload.ts`, `bean.d.ts`)

```ts
setAvatarMode: (mode: AvatarMode): void => ipcRenderer.send(IPC.setAvatarMode, mode),
planFromDrop: (skillName: string, droppedUrl: string): void =>
  ipcRenderer.send(IPC.planFromDrop, skillName, droppedUrl),
```
(`setAvatarMenuOpen` removed from both files; `bean.d.ts` gets the matching type signatures.)

### 4.7 Petal geometry (`packages/app/src/petal-geometry.ts`)

Pure, unit-testable geometry — same angle math as the mockup, rotated: the mockup fans
petals left of an off-center bean in a wide landscape canvas; our avatar window is square
with the bean centered, so the arc points up instead.

```ts
export interface Point { x: number; y: number; }

// ponytail: fixed arc + naive nearest-neighbor hit test. Revisit if skill count grows large
// enough to need wrapping/paging (see design doc §8).
const SPREAD_DEG = 130;
const CENTER_DEG = -90; // straight up

export function computePetalPositions(count: number, centerX: number, centerY: number, radius: number): Point[] {
  if (count <= 0) return [];
  if (count === 1) {
    const rad = (CENTER_DEG * Math.PI) / 180;
    return [{ x: centerX + radius * Math.cos(rad), y: centerY + radius * Math.sin(rad) }];
  }
  const step = SPREAD_DEG / (count - 1);
  const start = CENTER_DEG - SPREAD_DEG / 2;
  return Array.from({ length: count }, (_, i) => {
    const rad = ((start + i * step) * Math.PI) / 180;
    return { x: centerX + radius * Math.cos(rad), y: centerY + radius * Math.sin(rad) };
  });
}

export function nearestPetalIndex(x: number, y: number, positions: Point[], maxDist: number): number | undefined {
  let best: number | undefined;
  let bestDist = maxDist;
  positions.forEach((p, i) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}
```

### 4.8 Avatar renderer (`packages/app/src/renderer/avatar.ts`, `avatar.html`, new `drag-bloom.css`)

**The load-bearing constraint** (`.memory/safety-window-behavior.md`): the avatar body is a
`-webkit-app-region: drag` OS window-move region, which swallows mouse-driven events
(confirmed painfully during SP8 for click targets); anything that must receive
`dragenter`/`dragover`/`drop` has to be a real, properly-sized `no-drag` element — not a
zero-size wrapper. So the bloom container itself (not the individual petals) is the single
real, window-sized, `no-drag` drop target; petals are purely visual
(`pointer-events: none`) with hit-testing done by math against tracked cursor coordinates —
which is coincidentally exactly what the mockup's own demo code already does (it uses
`pointerEvents:'none'` wrappers and computes the nearest petal from raw coordinates, because
it's simulating drag with `pointermove`/`pointerup` in-page rather than real OS DnD).

`avatar.html` adds two elements alongside the existing `#bean`/`#bean-menu`:

```html
<div id="bean-drag-bloom" class="bean-drag-bloom"></div>
<div id="bean-reading" class="bean-reading">reading…</div>
```

`avatar.ts` replaces the current unconditional drop handler with mode-aware bloom logic
(reference implementation — refined during the build):

```ts
import { createOrb } from "./orb.js";
import type { ComponentKind, AvatarMode } from "../channels.js";
import { computePetalPositions, nearestPetalIndex } from "../petal-geometry.js";
import type { Skill, Project } from "@bean/core";

// ...existing setup (resizeTo, body drag region, el no-drag) unchanged...

const bloom = document.getElementById("bean-drag-bloom");
const reading = document.getElementById("bean-reading");

if (el && bloom && reading) {
  (bloom.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "no-drag";
  // ...orb/theme setup unchanged...

  let mode: AvatarMode = "normal";
  const setMode = (next: AvatarMode): void => { mode = next; window.bean.setAvatarMode(next); };

  // Bubble menu + drag-to-move: same behavior as today, just gated on the shared `mode`
  // instead of a standalone `menuOpen`/`dragging` boolean pair (see §4.3/4.4).

  const BEAN_CX = 220, BEAN_CY = 220; // center of the grown 440×440 window
  const PETAL_RADIUS = 150;
  let skills: Skill[] = [];
  let projects: Project[] = [];
  let petalPositions: { x: number; y: number }[] = [];
  let hoverIndex: number | undefined;

  const dataUrl = (e: DragEvent): string | undefined =>
    e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || undefined;

  const renderPetals = (): void => {
    const suggested = skills.find((s) => projects.some((p) => p.defaultSkill === s.name))?.name ?? skills[0]?.name;
    petalPositions = computePetalPositions(skills.length, BEAN_CX, BEAN_CY, PETAL_RADIUS);
    bloom.innerHTML = skills.map((s, i) => `
      <div class="bean-petal" data-index="${i}" style="left:${petalPositions[i]!.x}px;top:${petalPositions[i]!.y}px">
        ${s.name === suggested ? '<span class="bean-petal-badge">◆ best guess</span>' : ""}
        <span class="bean-petal-name">${s.name}</span>
        <span class="bean-petal-desc">${s.description}</span>
      </div>`).join("");
  };

  const setHover = (index: number | undefined): void => {
    if (hoverIndex === index) return;
    hoverIndex = index;
    bloom.querySelectorAll<HTMLElement>(".bean-petal").forEach((node) =>
      node.classList.toggle("bean-petal--active", Number(node.dataset.index) === index));
  };

  const closeBloom = (): void => {
    bloom.classList.remove("bean-drag-bloom--open");
    setHover(undefined);
    if (mode === "drag") setMode("normal");
  };

  el.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (mode !== "normal") return;
    void (async () => {
      [skills, projects] = await Promise.all([window.bean.listSkills(), window.bean.listProjects()]);
      if (skills.length === 0) return; // nothing to bloom — plain drop below handles it
      setMode("drag");
      renderPetals();
      bloom.classList.add("bean-drag-bloom--open");
    })();
  });

  bloom.addEventListener("dragover", (e) => {
    e.preventDefault();
    const rect = bloom.getBoundingClientRect();
    setHover(nearestPetalIndex(e.clientX - rect.left, e.clientY - rect.top, petalPositions, 90));
  });

  bloom.addEventListener("dragleave", (e) => { if (e.target === bloom) closeBloom(); });

  bloom.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = dataUrl(e);
    const chosen = hoverIndex !== undefined ? skills[hoverIndex] : undefined;
    closeBloom();
    if (url && chosen) {
      reading.classList.add("bean-reading--open");
      window.bean.planFromDrop(chosen.name, url);
      // ponytail: fixed cosmetic delay standing in for a real "reading the page" step.
      setTimeout(() => reading.classList.remove("bean-reading--open"), 700);
    } else if (url) {
      void window.bean.openComponent("chat", url); // no petal chosen — today's fallback
    }
  });

  // Fallback path: bloom never opened (e.g. zero skills configured) — same behavior as today.
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (mode === "drag") return; // the bloom's own drop handler already covers this
    const url = dataUrl(e);
    if (url) void window.bean.openComponent("chat", url);
  });
}
```

`drag-bloom.css` (new file, added to esbuild's static-copy list):

```css
.bean-drag-bloom {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 8;
  -webkit-app-region: no-drag;
}
.bean-drag-bloom--open { opacity: 1; pointer-events: auto; }

.bean-petal {
  position: absolute;
  width: 148px;
  transform: translate(-50%, -50%);
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 12px;
  padding: 8px 11px;
  pointer-events: none;
  box-shadow: 0 12px 30px -18px rgba(0, 0, 0, 0.6);
}
.bean-petal--active { border-color: var(--bean-accent); box-shadow: 0 0 0 3px var(--bean-accent), 0 16px 34px -18px rgba(0, 0, 0, 0.7); }
.bean-petal-badge {
  display: block; width: fit-content; margin-bottom: 4px;
  font: 700 9px ui-monospace, monospace; letter-spacing: 0.06em;
  color: var(--bean-accent-ink); background: var(--bean-accent);
  border-radius: 999px; padding: 2px 7px;
}
.bean-petal-name { display: block; font: 600 13px ui-monospace, monospace; color: var(--bean-text); }
.bean-petal-desc { display: block; font: 11px ui-monospace, monospace; color: var(--bean-text-dim); margin-top: 2px; }

.bean-reading {
  position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%);
  opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
  display: flex; align-items: center; gap: 7px;
  font: 12px ui-monospace, monospace; color: var(--bean-text);
  background: var(--bean-surface); border: 1px solid var(--bean-border);
  border-radius: 999px; padding: 6px 12px; z-index: 9;
}
.bean-reading--open { opacity: 1; }
```

### 4.9 Plan window (`packages/app/src/renderer/components/plan/`, `plan.html`)

Follows the exact pattern `persona`/`skills`/`projects` already use. `plan.html` mirrors
`persona.html` (theme/orb/shared CSS + a `#root` mount). `index.tsx` mirrors the other
components' one-liner render. `PlanWindow.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { TitleBar } from "../../shared/TitleBar.js";
import { ProposalCard } from "../../shared/ProposalCard.js";
import type { Theme } from "../../../channels.js";
import type { RouteSuggestion } from "@bean/core";

export function PlanWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [run, setRun] = useState<RouteSuggestion | undefined>(undefined);
  const [state, setState] = useState<"pending" | "confirmed" | "cancelled">("pending");

  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    window.bean.onProposeRun((suggestion) => { setRun(suggestion); setState("pending"); });
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && state === "pending") setState("cancelled"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")} />
      <div class="bean-single-column">
        <div class="bean-plan-header"><span class="bean-plan-dot" />Bean's plan · read from the link</div>
        {run ? (
          <ProposalCard
            run={run}
            state={state}
            onConfirm={(edited) => {
              setState("confirmed");
              void window.bean.run({ ...run, composedPrompt: edited });
              void window.bean.openComponent("chat"); // run output streams to Chat's console — see §4.10
            }}
            onCancel={() => setState("cancelled")}
          />
        ) : (
          <div class="bean-panel-empty">Waiting for a plan…</div>
        )}
      </div>
    </div>
  );
}
```

New CSS (`shared.css`, adjacent to the other component blocks):

```css
/* --- plan window --- */
.bean-plan-header {
  display: flex; align-items: center; gap: 9px;
  font: 600 12px ui-monospace, monospace; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--bean-text-dim);
}
.bean-plan-dot { width: 12px; height: 12px; border-radius: 4px; background: var(--bean-accent); }
```

### 4.10 Run wiring — one deliberate note

`runOpencode`'s progress events are always streamed to the **Chat** window's `webContents`
(`ipc.ts`'s `IPC.run` handler hardcodes `deps.chatSender()`), not whichever window called
`run()`. Building a second, parallel console view inside the Plan window would duplicate
`ConsolePanel` entirely. Instead, confirming a plan also calls `openComponent("chat")` so the
existing console becomes visible immediately — "Run" hands off to the app's one existing
run-visibility surface rather than growing a second one. The Plan window itself just shows
the disabled "Running…" button state `ProposalCard` already renders.

### 4.11 esbuild (`packages/app/esbuild.config.mjs`)

- Add `"src/renderer/components/plan/index.tsx"` to `rendererOpts.entryPoints`.
- Add `"plan"` to the html-copy loop (`for (const f of [..., "plan"])`).
- Add `"drag-bloom.css"` to the css-copy loop.

## 5. Error handling

- `listSkills()` resolves to `[]` (no skills configured) → bloom never opens; plain drop
  falls back to opening Chat with the URL, same as today. No error surfaced.
- `planForDroppedSkill` given a `skillName` that (racily) no longer matches any loaded skill
  → falls back to `skillName` as a bare string and an empty `composedPrompt` context (mirrors
  `route()`'s existing `compose(fallbackSkill, ...)` degradation style); not expected in
  practice since the name comes from the same `listSkills()` call that rendered the petal.
- No projects configured (`projects` is `[]`) → `projectPath` is `""`, same as `route()`'s
  existing fallback when there's no project at all — an existing, accepted edge case, not
  new here.
- Window `setBounds` during an active native OS drag session is the main technical risk (see
  §8) — if it turns out to visually glitch or cancel the drag on a real OS, the fallback is
  to grow the window on `dragenter` *before* any bloom is visible only once verified safe;
  no code branch needed for this, just a manual verification gate (§7).

## 6. Testing

**Core (vitest):** `planForDroppedSkill` — defaultSkill match, fallback to first project,
missing-skill degradation.

**App (vitest):** `petal-geometry` (`computePetalPositions` for 1/2/5 skills, arc math;
`nearestPetalIndex` hit/miss against a cutoff distance); `nextAvatarBounds`'s generalized
numeric-size signature (grow, shrink, the new drag size) replacing its current boolean-based
tests.

**Renderer (manual only, established convention — no DOM test infra in this repo):** the
live drag-bloom interaction itself, verified via `pnpm dev` per the checklist below. This is
the one piece I cannot verify myself in this environment (no GUI-automation tool, same
limitation noted in SP3/SP4/SP7/SP8) — flagging it explicitly rather than claiming it works.

**Gate:** `pnpm test && pnpm typecheck` from the repo root, both exit 0.

## 7. Manual verification checklist (for the plan's final task)

- Drag a link from a real browser onto Bean: window grows, petals bloom in an arc above the
  bean, one shows the "best guess" badge.
- Move the cursor across petals while still dragging: the nearest petal highlights live;
  moving off all petals but staying inside the window clears the highlight.
- Release over a highlighted petal: bloom collapses, a brief "reading…" pill shows, then the
  Plan window opens with the right skill/project chips and a sensible composed instruction;
  the avatar window shrinks back to 120×120.
- Release over empty space (no petal hovered): bloom collapses, avatar shrinks back, and
  Chat opens with the URL attached (today's exact old behavior) — no Plan window.
- Drag out of the window entirely without releasing: bloom collapses and the window shrinks
  back, nothing else happens.
- With `~/.bean/skills` empty: dragging a URL onto Bean never blooms; behaves exactly like
  today (opens Chat with the URL).
- Toggle Hearth/Graphite from any window: the Plan window and the bloom petals restyle
  correctly in both.
- Confirm a plan from the Plan window: Chat window opens/focuses and its console shows the
  run's live output; the Plan window's button shows "Running…".
- Bubble menu (dblclick) still opens/closes normally and is unaffected by the mode refactor;
  dragging a URL while the bubble menu is open does not bloom (gated on `mode === "normal"`).

## 8. Risks / open questions

- **Resizing the BrowserWindow mid native-OS-drag is unverified in this environment.** It's
  the same primitive the bubble menu already uses (just not mid-drag), and should be safe by
  the same reasoning spring-loaded Finder/Dock folders rely on, but it's flagged as the
  single biggest thing to confirm in the manual walkthrough (§7) — if it glitches, the
  fallback is a two-step interaction (drop first, then click a petal) instead of one
  continuous drag, which would need a small follow-up design change.
- **No pagination for many skills.** Petals spread evenly across a fixed 130° arc regardless
  of count; with a large skill library they'd overlap. Fine for the realistic case (a
  handful of skills); revisit if that changes.
- **Stubbed intelligence, twice over.** Both the best-guess badge and the plan's project
  inference are naive heuristics, not model calls — intentional per the brainstorm, but
  worth remembering these are the two obvious upgrade points for a later pass.
</content>
