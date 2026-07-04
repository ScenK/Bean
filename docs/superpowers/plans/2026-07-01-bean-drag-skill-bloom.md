# Bean — Drag-to-Skill-Bloom + Plan Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dragging a URL onto Bean blooms a radial fan of skill petals around it; releasing
over a petal composes a plan (skill + project + instruction, no typing required) and opens a
new standalone Plan window with Run/Cancel; releasing without a petal (or with no skills
configured) falls back to today's "open Chat with the URL attached" behavior.

**Architecture:** A pure core function (`planForDroppedSkill`) composes the plan with no
model call (naive heuristics, explicitly deferred to a later pass). The avatar window grows
around its current center (reusing/generalizing the bubble-menu's window-bounds trick) to
show the bloom; a single real, window-sized, no-drag container is the actual native-DnD drop
target (petals are purely visual, hit-tested by math) per the hard-won
`.memory/safety-window-behavior.md` lesson. A new `"plan"` component window follows the exact
pattern the other four (`chat`/`skills`/`persona`/`projects`) already use, and reuses the
existing `ProposalCard`/`TitleBar` — no new run-wiring.

**Tech Stack:** TypeScript, Electron, Preact (component windows only — the avatar renderer
is plain DOM/TS), vitest, esbuild. No new dependencies.

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected — new business logic
  (`planForDroppedSkill`) goes there, not in `app/`.
- IPC channel names live only in `packages/app/src/channels.ts`'s `IPC` object, referenced
  via `IPC.*` — never string-literal a channel name elsewhere.
- Electron preload (`preload.ts`) stays CommonJS `.cjs`-compatible (no ESM syntax leaking
  into the built `dist/preload.cjs` — the existing esbuild `check-preload-cjs` plugin
  enforces this automatically on every build).
- No new test-framework dependency. Pure logic (core functions, geometry helpers, bounds
  math) is unit-tested with vitest and injected fakes. Renderer UI (the avatar's live drag
  interaction, the Plan window's visual layout) has no DOM test infra in this repo and is
  verified manually via `pnpm dev`, per established convention.
- No real model/LLM call is added anywhere in this feature — the "best guess" petal badge
  and the plan's project inference are both explicitly naive, no-network heuristics (see
  design doc §2). Do not "improve" this during implementation; it's intentional.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0, before any
  task is considered done. Turbo's `^build` dependency means these root commands already
  rebuild `@bean/core`'s `dist/` first when needed — no manual per-package build step.

Design doc: `docs/superpowers/specs/2026-07-01-bean-drag-skill-bloom-design.md` (read this
first for the "why" behind every decision below).

---

### Task 1: Core — `planForDroppedSkill`

**Files:**
- Create: `packages/core/src/drop-plan.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/__test__/drop-plan.test.ts`

**Interfaces:**
- Consumes: `composePrompt(skill: Skill, instruction: string, url?: string): string` from
  `./prompt.js` (existing, unchanged); `Skill`, `Project`, `RouteSuggestion` from
  `./types.js` (existing, unchanged).
- Produces: `planForDroppedSkill(skillName: string, droppedUrl: string, skills: Skill[], projects: Project[]): RouteSuggestion` —
  consumed by Task 4's `main.ts` wiring.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/drop-plan.test.ts`:

```ts
import { expect, test } from "vitest";
import { planForDroppedSkill } from "../src/drop-plan.js";
import type { Project, Skill } from "../src/types.js";

const skills: Skill[] = [
  { name: "triage-issues", description: "reproduce + plan", body: "TRIAGE BODY" },
  { name: "write-tests", description: "cover the fix", body: "TEST BODY" },
];
const projects: Project[] = [
  { name: "api", path: "/dev/api", defaultSkill: "triage-issues" },
  { name: "core", path: "/dev/core" },
];

test("matches the project whose defaultSkill equals the dropped skill", () => {
  const plan = planForDroppedSkill("triage-issues", "https://jira/PROJ-1", skills, projects);
  expect(plan.skillName).toBe("triage-issues");
  expect(plan.projectPath).toBe("/dev/api");
  expect(plan.composedPrompt).toContain("TRIAGE BODY");
  expect(plan.composedPrompt).toContain("https://jira/PROJ-1");
  expect(plan.confidence).toBe(0);
});

test("falls back to the first project when no defaultSkill matches", () => {
  const plan = planForDroppedSkill("write-tests", "https://x", skills, projects);
  expect(plan.skillName).toBe("write-tests");
  expect(plan.projectPath).toBe("/dev/api");
});

test("degrades gracefully when the skill name no longer matches any loaded skill", () => {
  const plan = planForDroppedSkill("nonexistent-skill", "https://x", skills, projects);
  expect(plan.skillName).toBe("nonexistent-skill");
  expect(plan.projectPath).toBe("/dev/api");
  expect(plan.composedPrompt).toBe("https://x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/drop-plan.test.ts`
Expected: FAIL — cannot resolve `../src/drop-plan.js` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/drop-plan.ts`:

```ts
import { composePrompt } from "./prompt.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";

// ponytail: naive project match, no model call — same "hardcode it, revisit the real
// inference later" call made for the avatar's best-guess petal badge (see the drag-bloom
// design doc, packages/app side). Upgrade path: a real route()-style model call once this
// needs to be smarter than "match defaultSkill, else first project".
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

- [ ] **Step 4: Export it from the package entrypoint**

Modify `packages/core/src/index.ts` — add one line (keep the existing ones untouched):

```ts
export * from "./types.js";
export * from "./prompt.js";
export * from "./skill-library.js";
export * from "./project-registry.js";
export * from "./config.js";
export * from "./persona.js";
export * from "./persona-store.js";
export * from "./router.js";
export * from "./converse.js";
export * from "./openai-chat.js";
export * from "./runner.js";
export * from "./terminal.js";
export * from "./launcher.js";
export * from "./drop-plan.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/drop-plan.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/drop-plan.ts packages/core/src/index.ts packages/core/__test__/drop-plan.test.ts
git commit -m "feat(core): add planForDroppedSkill for forced-skill plan composition"
```

---

### Task 2: App — petal geometry helpers

**Files:**
- Create: `packages/app/src/petal-geometry.ts`
- Test: `packages/app/__test__/petal-geometry.test.ts`

**Interfaces:**
- Produces: `Point { x: number; y: number }`;
  `computePetalPositions(count: number, centerX: number, centerY: number, radius: number): Point[]`;
  `nearestPetalIndex(x: number, y: number, positions: Point[], maxDist: number): number | undefined` —
  both consumed by Task 7's `avatar.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/__test__/petal-geometry.test.ts`:

```ts
import { expect, test } from "vitest";
import { computePetalPositions, nearestPetalIndex } from "../src/petal-geometry.js";

test("returns no petals for zero skills", () => {
  expect(computePetalPositions(0, 100, 100, 50)).toEqual([]);
});

test("a single petal sits directly above the center", () => {
  const [p] = computePetalPositions(1, 100, 100, 50);
  expect(p!.x).toBeCloseTo(100, 5);
  expect(p!.y).toBeCloseTo(50, 5); // 100 - radius
});

test("multiple petals fan symmetrically above the center, evenly spaced", () => {
  const positions = computePetalPositions(5, 100, 100, 50);
  expect(positions).toHaveLength(5);
  // symmetric around the vertical axis through the center
  expect(positions[0]!.x + positions[4]!.x).toBeCloseTo(200, 5);
  expect(positions[1]!.x + positions[3]!.x).toBeCloseTo(200, 5);
  // the arc points up: every petal is above the center (smaller y)
  for (const p of positions) expect(p.y).toBeLessThan(100);
  // no two petals land on top of each other
  const xs = new Set(positions.map((p) => Math.round(p.x)));
  expect(xs.size).toBe(5);
});

test("nearestPetalIndex returns the closest petal within maxDist", () => {
  const positions = [{ x: 10, y: 10 }, { x: 100, y: 100 }];
  expect(nearestPetalIndex(12, 11, positions, 20)).toBe(0);
  expect(nearestPetalIndex(98, 102, positions, 20)).toBe(1);
});

test("nearestPetalIndex returns undefined when nothing is within maxDist", () => {
  const positions = [{ x: 10, y: 10 }, { x: 100, y: 100 }];
  expect(nearestPetalIndex(500, 500, positions, 20)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/petal-geometry.test.ts`
Expected: FAIL — cannot resolve `../src/petal-geometry.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/app/src/petal-geometry.ts`:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/petal-geometry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/petal-geometry.ts packages/app/__test__/petal-geometry.test.ts
git commit -m "feat(app): add petal geometry helpers for the avatar's skill bloom"
```

---

### Task 3: App — generalize avatar window sizing to a 3-state mode

Generalizes the bubble menu's boolean open/closed window-bounds trick to 3 sizes
(normal/menu/drag), and re-routes the bubble menu through it. This task changes the mode
plumbing only — it does **not** add the drag-bloom feature itself (that's Task 7). After
this task the app must build and the bubble menu must work exactly as before.

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/avatar-menu.ts`
- Test: `packages/app/__test__/avatar-menu.test.ts` (rewritten)
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/renderer/avatar.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `AvatarMode = "normal" | "menu" | "drag"` (channels.ts);
  `nextAvatarBounds(current: Bounds, targetSize: number): Bounds` (generalized signature);
  `avatarSizeForMode(mode: AvatarMode): number`; `AVATAR_DRAG_SIZE = 440` — all consumed by
  Task 7's `avatar.ts` bloom logic and by `ipc.ts`.

- [ ] **Step 1: `channels.ts` — add `AvatarMode`, rename the IPC channel**

Modify `packages/app/src/channels.ts`. Change:

```ts
export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects";
```
to:
```ts
export type Theme = "hearth" | "graphite";
export type ComponentKind = "chat" | "skills" | "persona" | "projects";
export type AvatarMode = "normal" | "menu" | "drag";
```

And change the last two entries of the `IPC` object from:
```ts
  moveWindowBy: "bean:move-window-by",
  setAvatarMenuOpen: "bean:set-avatar-menu-open",
} as const;
```
to:
```ts
  moveWindowBy: "bean:move-window-by",
  setAvatarMode: "bean:set-avatar-mode",
} as const;
```

- [ ] **Step 2: Write the failing test for the generalized bounds math**

Replace `packages/app/__test__/avatar-menu.test.ts` entirely with:

```ts
import { expect, test } from "vitest";
import { AVATAR_DRAG_SIZE, AVATAR_MENU_SIZE, AVATAR_SIZE, avatarSizeForMode, nextAvatarBounds } from "../src/avatar-menu.js";

test("growing to the menu size grows the window, centered on its current position", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE, height: AVATAR_SIZE };
  const opened = nextAvatarBounds(closed, AVATAR_MENU_SIZE);
  expect(opened).toEqual({ x: 10, y: 10, width: AVATAR_MENU_SIZE, height: AVATAR_MENU_SIZE });
});

test("shrinking back to the normal size restores the exact original bounds", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE, height: AVATAR_SIZE };
  const opened = nextAvatarBounds(closed, AVATAR_MENU_SIZE);
  const reClosed = nextAvatarBounds(opened, AVATAR_SIZE);
  expect(reClosed).toEqual(closed);
});

test("growing to the drag-bloom size grows the window, centered on its current position", () => {
  const closed = { x: 100, y: 100, width: AVATAR_SIZE, height: AVATAR_SIZE };
  const opened = nextAvatarBounds(closed, AVATAR_DRAG_SIZE);
  const delta = (AVATAR_DRAG_SIZE - AVATAR_SIZE) / 2;
  expect(opened).toEqual({ x: 100 - delta, y: 100 - delta, width: AVATAR_DRAG_SIZE, height: AVATAR_DRAG_SIZE });
});

test("avatarSizeForMode maps each mode to its window size", () => {
  expect(avatarSizeForMode("normal")).toBe(AVATAR_SIZE);
  expect(avatarSizeForMode("menu")).toBe(AVATAR_MENU_SIZE);
  expect(avatarSizeForMode("drag")).toBe(AVATAR_DRAG_SIZE);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/avatar-menu.test.ts`
Expected: FAIL — `nextAvatarBounds` still takes a boolean, `AVATAR_DRAG_SIZE`/`avatarSizeForMode` don't exist.

- [ ] **Step 4: Rewrite `avatar-menu.ts`**

Replace `packages/app/src/avatar-menu.ts` entirely with:

```ts
import type { AvatarMode } from "./channels.js";

export const AVATAR_SIZE = 120;
export const AVATAR_MENU_SIZE = 300;
export const AVATAR_DRAG_SIZE = 440;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the avatar window's next bounds when it grows/shrinks to a new target size
 * (idle 120, bubble menu 300, drag-skill-bloom 440). Grows/shrinks symmetrically around
 * the window's current center so the bean itself doesn't visually jump.
 */
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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/avatar-menu.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Update `ipc.ts` to use the generalized mode handler**

Modify `packages/app/src/ipc.ts`. Change the import line from:
```ts
import { IPC, type Theme, type ComponentKind } from "./channels.js";
import { nextAvatarBounds } from "./avatar-menu.js";
```
to:
```ts
import { IPC, type Theme, type ComponentKind, type AvatarMode } from "./channels.js";
import { avatarSizeForMode, nextAvatarBounds } from "./avatar-menu.js";
```

Change the bubble-menu handler at the bottom of `registerIpc` from:
```ts
  // Bubble menu: grows/shrinks the avatar window around its current position.
  let avatarMenuOpen = false;
  ipcMain.on(IPC.setAvatarMenuOpen, (e, open: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || open === avatarMenuOpen) return;
    avatarMenuOpen = open;
    win.setBounds(nextAvatarBounds(win.getBounds(), open));
  });
}
```
to:
```ts
  // Avatar window growth: one shared mode (normal/menu/drag) drives its bounds —
  // setBounds to an already-current size is a harmless no-op, so no open/closed
  // tracking state is needed here.
  ipcMain.on(IPC.setAvatarMode, (e, mode: AvatarMode) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.setBounds(nextAvatarBounds(win.getBounds(), avatarSizeForMode(mode)));
  });
}
```

- [ ] **Step 7: Update `preload.ts`**

Modify `packages/app/src/preload.ts`. Change the import line from:
```ts
import { IPC, type Theme, type ComponentKind } from "./channels.js";
```
to:
```ts
import { IPC, type Theme, type ComponentKind, type AvatarMode } from "./channels.js";
```

Change:
```ts
  setAvatarMenuOpen: (open: boolean): void => ipcRenderer.send(IPC.setAvatarMenuOpen, open),
```
to:
```ts
  setAvatarMode: (mode: AvatarMode): void => ipcRenderer.send(IPC.setAvatarMode, mode),
```

- [ ] **Step 8: Update `bean.d.ts`**

Modify `packages/app/src/renderer/bean.d.ts`. Change the import line from:
```ts
import type { Theme, ComponentKind } from "../channels.js";
```
to:
```ts
import type { Theme, ComponentKind, AvatarMode } from "../channels.js";
```

Change:
```ts
      setAvatarMenuOpen(open: boolean): void;
```
to:
```ts
      setAvatarMode(mode: AvatarMode): void;
```

- [ ] **Step 9: Update `avatar.ts` to route the bubble menu through the shared mode**

Modify `packages/app/src/renderer/avatar.ts`. Change the import line from:
```ts
import { createOrb } from "./orb.js";
import type { ComponentKind } from "../channels.js";
```
to:
```ts
import { createOrb } from "./orb.js";
import type { AvatarMode, ComponentKind } from "../channels.js";
```

Change the bubble-menu block from:
```ts
  // Bubble menu: dblclick toggles it; picking a bubble opens that component and
  // closes the menu; clicking outside it or pressing Escape also closes it.
  let menuOpen = false;
  const setMenuOpen = (open: boolean): void => {
    menuOpen = open;
    menu?.classList.toggle("bean-menu--open", open);
    window.bean.setAvatarMenuOpen(open);
  };

  el.addEventListener("dblclick", () => { setMenuOpen(!menuOpen); });

  menu?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-bubble-btn");
    if (!btn) return;
    void window.bean.openComponent(btn.dataset.kind as ComponentKind);
    setMenuOpen(false);
  });

  window.addEventListener("click", (e) => {
    if (!menuOpen) return;
    const target = e.target as HTMLElement;
    if (target === el || target.closest(".bean-bubble-btn")) return;
    setMenuOpen(false);
  });

  window.addEventListener("keydown", (e) => {
    if (menuOpen && e.key === "Escape") setMenuOpen(false);
  });
```
to:
```ts
  // Avatar mode: "normal" | "menu" (bubble menu open) | "drag" (skill bloom open while
  // dragging a URL onto Bean, wired up in a later task). Drives the window's grown size
  // via the main process (see avatar-menu.ts).
  let mode: AvatarMode = "normal";
  const setMode = (next: AvatarMode): void => {
    mode = next;
    window.bean.setAvatarMode(next);
  };

  // Bubble menu: dblclick toggles it; picking a bubble opens that component and
  // closes the menu; clicking outside it or pressing Escape also closes it.
  const setMenuOpen = (open: boolean): void => {
    menu?.classList.toggle("bean-menu--open", open);
    setMode(open ? "menu" : "normal");
  };

  el.addEventListener("dblclick", () => { setMenuOpen(mode !== "menu"); });

  menu?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-bubble-btn");
    if (!btn) return;
    void window.bean.openComponent(btn.dataset.kind as ComponentKind);
    setMenuOpen(false);
  });

  window.addEventListener("click", (e) => {
    if (mode !== "menu") return;
    const target = e.target as HTMLElement;
    if (target === el || target.closest(".bean-bubble-btn")) return;
    setMenuOpen(false);
  });

  window.addEventListener("keydown", (e) => {
    if (mode === "menu" && e.key === "Escape") setMenuOpen(false);
  });
```

And change the drag-to-move guard from:
```ts
  el.addEventListener("mousedown", (e) => {
    if (menuOpen) return;
```
to:
```ts
  el.addEventListener("mousedown", (e) => {
    if (mode !== "normal") return;
```

- [ ] **Step 10: Verify the whole workspace still builds and typechecks**

Run: `pnpm typecheck`
Expected: exit 0 for both `@bean/core` and `@bean/app`.

Run: `pnpm test`
Expected: exit 0 (all existing suites plus the rewritten `avatar-menu.test.ts` pass).

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/avatar-menu.ts packages/app/__test__/avatar-menu.test.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/renderer/avatar.ts
git commit -m "refactor(app): generalize avatar window bounds to a 3-state mode (normal/menu/drag)"
```

---

### Task 4: App — `"plan"` component kind, `planFromDrop` IPC, compact window sizing

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/windows.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`

**Interfaces:**
- Consumes: `planForDroppedSkill` (Task 1); `ComponentKind`, `IPC` (Task 3's `channels.ts`).
- Produces: `ComponentKind` including `"plan"`; `IPC.planFromDrop`;
  `window.bean.planFromDrop(skillName: string, droppedUrl: string): void` — consumed by
  Task 7's `avatar.ts`. `createComponentWindow("plan")` sized 480×460 — consumed by Task 5.

No new automated test in this task: `registerIpc`'s raw `ipcMain.on`/`.handle` wiring has no
existing test coverage in this repo (only its extracted `build*Handler` functions are unit
tested), so this task is verified via typecheck + build, matching that existing precedent.

- [ ] **Step 1: `channels.ts` — add the `"plan"` kind and its IPC channel**

Modify `packages/app/src/channels.ts`. Change:
```ts
export type ComponentKind = "chat" | "skills" | "persona" | "projects";
```
to:
```ts
export type ComponentKind = "chat" | "skills" | "persona" | "projects" | "plan";
```

Change the end of the `IPC` object from:
```ts
  moveWindowBy: "bean:move-window-by",
  setAvatarMode: "bean:set-avatar-mode",
} as const;
```
to:
```ts
  moveWindowBy: "bean:move-window-by",
  setAvatarMode: "bean:set-avatar-mode",
  planFromDrop: "bean:plan-from-drop",
} as const;
```

- [ ] **Step 2: `windows.ts` — per-kind window sizing**

Replace `packages/app/src/windows.ts` entirely with:

```ts
import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ComponentKind } from "./channels.js";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "preload.cjs");
const renderer = (name: string) => join(here, "renderer", `${name}.html`);

// Most component windows share one dashboard-sized default; the Plan window is a compact
// confirm card, not a dashboard, so it gets its own smaller size.
const COMPONENT_WINDOW_SIZE: Record<ComponentKind, { width: number; height: number }> = {
  chat: { width: 1040, height: 720 },
  skills: { width: 1040, height: 720 },
  persona: { width: 1040, height: 720 },
  projects: { width: 1040, height: 720 },
  plan: { width: 480, height: 460 },
};

export function createAvatarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 120, height: 120, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false,
    webPreferences: { preload },
  });
  void win.loadFile(renderer("avatar"));
  return win;
}

export function createComponentWindow(kind: ComponentKind): BrowserWindow {
  const { width, height } = COMPONENT_WINDOW_SIZE[kind];
  const win = new BrowserWindow({
    width, height,
    webPreferences: { preload },
  });
  void win.loadFile(renderer(kind));
  return win;
}
```

- [ ] **Step 3: `ipc.ts` — wire `planFromDrop`**

Modify `packages/app/src/ipc.ts`. Add one field to `RegisterDeps` — change:
```ts
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  spawnLaunch?: LaunchSpawnFn;
}
```
to:
```ts
  openComponent: (kind: ComponentKind, droppedUrl?: string) => void;
  proposeRun: (suggestion: RouteSuggestion) => void;
  planFromDrop: (skillName: string, droppedUrl: string) => void;
  spawnLaunch?: LaunchSpawnFn;
}
```

Add the handler right after the existing `proposeRun` one — change:
```ts
  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, droppedUrl?: string) => deps.openComponent(kind, droppedUrl));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
```
to:
```ts
  ipcMain.handle(IPC.openComponent, (_e, kind: ComponentKind, droppedUrl?: string) => deps.openComponent(kind, droppedUrl));
  ipcMain.on(IPC.proposeRun, (_e, suggestion: RouteSuggestion) => deps.proposeRun(suggestion));
  ipcMain.on(IPC.planFromDrop, (_e, skillName: string, droppedUrl: string) => deps.planFromDrop(skillName, droppedUrl));
```

- [ ] **Step 4: `main.ts` — implement `planFromDrop`**

Modify `packages/app/src/main.ts`. Change the import from:
```ts
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile,
  loadConfig, loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
  makeOpenAIChat, makeOpenAIConverse,
} from "@bean/core";
```
to:
```ts
import {
  beanDir, configFile, projectsFile, skillsDir, personaFile,
  loadConfig, loadSkills, loadProjects, saveSkill, loadPersona, savePersona,
  makeOpenAIChat, makeOpenAIConverse, planForDroppedSkill,
} from "@bean/core";
```

Add the new function right after `proposeRun` — change:
```ts
  const proposeRun = (suggestion: RouteSuggestion): void => {
    openComponent("chat");
    sendWhenReady(componentWindows.get("chat")!, IPC.proposeRun, suggestion);
  };
```
to:
```ts
  const proposeRun = (suggestion: RouteSuggestion): void => {
    openComponent("chat");
    sendWhenReady(componentWindows.get("chat")!, IPC.proposeRun, suggestion);
  };
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
```

Pass it into `registerIpc` — change:
```ts
      chatSender: () => componentWindows.get("chat")?.webContents,
      projectsSender: () => componentWindows.get("projects")?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun,
    });
```
to:
```ts
      chatSender: () => componentWindows.get("chat")?.webContents,
      projectsSender: () => componentWindows.get("projects")?.webContents,
      getCurrentTheme, setCurrentTheme, broadcast, openComponent, proposeRun, planFromDrop,
    });
```

- [ ] **Step 5: `preload.ts` — expose `planFromDrop`**

Modify `packages/app/src/preload.ts`. Add, right after the `setAvatarMode` line:
```ts
  setAvatarMode: (mode: AvatarMode): void => ipcRenderer.send(IPC.setAvatarMode, mode),
  planFromDrop: (skillName: string, droppedUrl: string): void =>
    ipcRenderer.send(IPC.planFromDrop, skillName, droppedUrl),
```

- [ ] **Step 6: `bean.d.ts` — add the matching type**

Modify `packages/app/src/renderer/bean.d.ts`. Add, right after the `setAvatarMode` line:
```ts
      setAvatarMode(mode: AvatarMode): void;
      planFromDrop(skillName: string, droppedUrl: string): void;
```

- [ ] **Step 7: Verify**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/windows.ts packages/app/src/ipc.ts packages/app/src/main.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts
git commit -m "feat(app): add the plan component kind and planFromDrop IPC"
```

---

### Task 5: App — Plan window (Preact component + esbuild entry)

**Files:**
- Create: `packages/app/src/renderer/plan.html`
- Create: `packages/app/src/renderer/components/plan/index.tsx`
- Create: `packages/app/src/renderer/components/plan/PlanWindow.tsx`
- Modify: `packages/app/src/renderer/shared.css`
- Modify: `packages/app/esbuild.config.mjs`

**Interfaces:**
- Consumes: `TitleBar` (`../../shared/TitleBar.js`), `ProposalCard` (`../../shared/ProposalCard.js`),
  `window.bean.onProposeRun`/`window.bean.run`/`window.bean.getTheme`/`window.bean.onThemeChanged`/
  `window.bean.setTheme` (all existing, unchanged).
- Produces: the `"plan"` window's renderer entry, loadable via `createComponentWindow("plan")`
  (Task 4).

No automated test — renderer visual layout, same established convention as every other
component window (`PersonaWindow`, `SkillsWindow`, etc.). Verified via typecheck + build now;
visual/manual check happens in Task 8.

- [ ] **Step 1: Create `plan.html`**

Create `packages/app/src/renderer/plan.html`:

```html
<!-- packages/app/src/renderer/plan.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="orb.css" />
    <link rel="stylesheet" href="shared.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="components/plan/index.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `PlanWindow.tsx`**

Create `packages/app/src/renderer/components/plan/PlanWindow.tsx`:

```tsx
// packages/app/src/renderer/components/plan/PlanWindow.tsx
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && state === "pending") setState("cancelled");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  return (
    <div class="bean-dashboard">
      <TitleBar theme={theme} onToggleTheme={() => void window.bean.setTheme(theme === "hearth" ? "graphite" : "hearth")} />
      <div class="bean-single-column">
        <div class="bean-plan-header">
          <span class="bean-plan-dot" />
          <span>Bean's plan · read from the link</span>
        </div>
        {run ? (
          <ProposalCard
            run={run}
            state={state}
            onConfirm={(edited) => {
              setState("confirmed");
              void window.bean.run({ ...run, composedPrompt: edited });
              // Run output always streams to the Chat window's console (see ipc.ts's
              // IPC.run handler) — bring Chat forward so the user sees it immediately.
              void window.bean.openComponent("chat");
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

- [ ] **Step 3: Create `index.tsx`**

Create `packages/app/src/renderer/components/plan/index.tsx`:

```tsx
// packages/app/src/renderer/components/plan/index.tsx
import { render } from "preact";
import { PlanWindow } from "./PlanWindow.js";

const root = document.getElementById("root");
if (root) render(<PlanWindow />, root);
```

- [ ] **Step 4: Add Plan window CSS**

Modify `packages/app/src/renderer/shared.css` — append at the end of the file:

```css

/* --- plan window --- */
.bean-plan-header {
  display: flex;
  align-items: center;
  gap: 9px;
  font: 600 12px ui-monospace, monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--bean-text-dim);
}
.bean-plan-dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  background: var(--bean-accent);
}
```

- [ ] **Step 5: Register the new entry point and HTML copy in esbuild**

Modify `packages/app/esbuild.config.mjs`. Change the `rendererOpts.entryPoints` array from:
```js
  entryPoints: [
    "src/renderer/avatar.ts",
    "src/renderer/components/chat/index.tsx",
    "src/renderer/components/skills/index.tsx",
    "src/renderer/components/persona/index.tsx",
    "src/renderer/components/projects/index.tsx",
  ],
```
to:
```js
  entryPoints: [
    "src/renderer/avatar.ts",
    "src/renderer/components/chat/index.tsx",
    "src/renderer/components/skills/index.tsx",
    "src/renderer/components/persona/index.tsx",
    "src/renderer/components/projects/index.tsx",
    "src/renderer/components/plan/index.tsx",
  ],
```

Change the html-copy loop from:
```js
  for (const f of ["avatar", "chat", "skills", "persona", "projects"]) {
```
to:
```js
  for (const f of ["avatar", "chat", "skills", "persona", "projects", "plan"]) {
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm build`
Expected: exit 0. Confirm the new files exist: `ls packages/app/dist/renderer/plan.html packages/app/dist/renderer/components/plan/index.js`.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/renderer/plan.html packages/app/src/renderer/components/plan packages/app/src/renderer/shared.css packages/app/esbuild.config.mjs
git commit -m "feat(app): add the Plan window (reuses ProposalCard/TitleBar)"
```

---

### Task 6: App — avatar bloom markup + CSS

**Files:**
- Create: `packages/app/src/renderer/drag-bloom.css`
- Modify: `packages/app/src/renderer/avatar.html`
- Modify: `packages/app/esbuild.config.mjs`

**Interfaces:**
- Produces: `#bean-drag-bloom` and `#bean-reading` DOM elements and their CSS classes
  (`.bean-drag-bloom`, `.bean-drag-bloom--open`, `.bean-petal`, `.bean-petal--active`,
  `.bean-petal-badge`, `.bean-petal-name`, `.bean-petal-desc`, `.bean-reading`,
  `.bean-reading--open`) — consumed by Task 7's `avatar.ts`.

No automated test — pure markup/CSS, verified via build + Task 8's manual walkthrough.

- [ ] **Step 1: Create `drag-bloom.css`**

Create `packages/app/src/renderer/drag-bloom.css`:

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
.bean-petal--active {
  border-color: var(--bean-accent);
  box-shadow: 0 0 0 3px var(--bean-accent), 0 16px 34px -18px rgba(0, 0, 0, 0.7);
}
.bean-petal-badge {
  display: block;
  width: fit-content;
  margin-bottom: 4px;
  font: 700 9px ui-monospace, monospace;
  letter-spacing: 0.06em;
  color: var(--bean-accent-ink);
  background: var(--bean-accent);
  border-radius: 999px;
  padding: 2px 7px;
}
.bean-petal-name {
  display: block;
  font: 600 13px ui-monospace, monospace;
  color: var(--bean-text);
}
.bean-petal-desc {
  display: block;
  font: 11px ui-monospace, monospace;
  color: var(--bean-text-dim);
  margin-top: 2px;
}

.bean-reading {
  position: absolute;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  display: flex;
  align-items: center;
  gap: 7px;
  font: 12px ui-monospace, monospace;
  color: var(--bean-text);
  background: var(--bean-surface);
  border: 1px solid var(--bean-border);
  border-radius: 999px;
  padding: 6px 12px;
  z-index: 9;
}
.bean-reading--open { opacity: 1; }
```

- [ ] **Step 2: Add the bloom + reading-pill markup to `avatar.html`**

Modify `packages/app/src/renderer/avatar.html`. Add the stylesheet link — change:
```html
    <link rel="stylesheet" href="bubble-menu.css" />
    <style>
```
to:
```html
    <link rel="stylesheet" href="bubble-menu.css" />
    <link rel="stylesheet" href="drag-bloom.css" />
    <style>
```

Add the two new elements — change:
```html
    <div id="bean-menu" class="bean-menu">
      <button type="button" class="bean-bubble-btn bean-bubble-btn--chat" data-kind="chat">Chat</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--skills" data-kind="skills">Skills</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--persona" data-kind="persona">Persona</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--projects" data-kind="projects">Projects</button>
    </div>
    <script type="module" src="avatar.js"></script>
```
to:
```html
    <div id="bean-menu" class="bean-menu">
      <button type="button" class="bean-bubble-btn bean-bubble-btn--chat" data-kind="chat">Chat</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--skills" data-kind="skills">Skills</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--persona" data-kind="persona">Persona</button>
      <button type="button" class="bean-bubble-btn bean-bubble-btn--projects" data-kind="projects">Projects</button>
    </div>
    <div id="bean-drag-bloom" class="bean-drag-bloom"></div>
    <div id="bean-reading" class="bean-reading">reading…</div>
    <script type="module" src="avatar.js"></script>
```

- [ ] **Step 3: Register the new CSS file in esbuild's static-copy list**

Modify `packages/app/esbuild.config.mjs`. Change:
```js
  for (const f of ["theme.css", "orb.css", "shared.css", "bubble-menu.css"]) {
```
to:
```js
  for (const f of ["theme.css", "orb.css", "shared.css", "bubble-menu.css", "drag-bloom.css"]) {
```

- [ ] **Step 4: Verify**

Run: `pnpm build`
Expected: exit 0. Confirm: `ls packages/app/dist/renderer/drag-bloom.css`.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/renderer/drag-bloom.css packages/app/src/renderer/avatar.html packages/app/esbuild.config.mjs
git commit -m "feat(app): add avatar drag-bloom markup and CSS"
```

---

### Task 7: App — avatar drag-bloom interaction logic

**Files:**
- Modify: `packages/app/src/renderer/avatar.ts`

**Interfaces:**
- Consumes: `computePetalPositions`, `nearestPetalIndex` (Task 2); `AVATAR_DRAG_SIZE`
  (Task 3, via the main-process side — not imported here directly, just relied upon
  implicitly through `BEAN_CX`/`BEAN_CY` matching its center); `window.bean.listSkills()`,
  `window.bean.listProjects()`, `window.bean.planFromDrop()`, `window.bean.openComponent()`
  (all existing/Task 4); `#bean-drag-bloom`/`#bean-reading` and their CSS classes (Task 6);
  the shared `mode`/`setMode` from Task 3.
- Produces: the complete drag-to-skill-bloom interaction — nothing further consumes this
  directly (it's the feature's UI entry point).

No automated test — live native OS drag-and-drop has no DOM test infra in this repo (same
established limitation as every other renderer-only interaction in this codebase). Verified
via typecheck now; the actual interaction is exercised in Task 8's manual walkthrough.

- [ ] **Step 1: Add the new imports and DOM references**

Modify `packages/app/src/renderer/avatar.ts`. Change the import block from:
```ts
import { createOrb } from "./orb.js";
import type { AvatarMode, ComponentKind } from "../channels.js";
```
to:
```ts
import { createOrb } from "./orb.js";
import type { AvatarMode, ComponentKind } from "../channels.js";
import { computePetalPositions, nearestPetalIndex } from "../petal-geometry.js";
import type { Project, Skill } from "@bean/core";
```

Change:
```ts
const el = document.getElementById("bean");
const menu = document.getElementById("bean-menu");

if (el) {
```
to:
```ts
const el = document.getElementById("bean");
const menu = document.getElementById("bean-menu");
const bloom = document.getElementById("bean-drag-bloom");
const reading = document.getElementById("bean-reading");

if (el && bloom && reading) {
```

- [ ] **Step 2: Replace the plain drop handler with the bloom interaction**

Change:
```ts
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url) void window.bean.openComponent("chat", url);
  });
```
to:
```ts
  // Drag a URL onto Bean: dragenter blooms a radial fan of skill petals around the
  // (temporarily grown) window; dragover tracks the cursor and highlights the nearest
  // petal; drop commits to whichever was last highlighted. The bloom container itself —
  // not the individual petals — is the real, window-sized, no-drag drop target (petals
  // are pointer-events:none and hit-tested by math): the avatar body is a
  // -webkit-app-region:drag OS window-move region that swallows mouse-driven events on
  // anything that isn't a real, properly-sized no-drag element (see
  // .memory/safety-window-behavior.md) — a zero-size or fragmented drop target wouldn't
  // reliably receive dragover/drop here.
  const BEAN_CX = 220, BEAN_CY = 220; // center of the grown 440×440 window (AVATAR_DRAG_SIZE)
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

  bloom.addEventListener("dragleave", (e) => {
    if (e.target === bloom) closeBloom();
  });

  bloom.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = dataUrl(e);
    const chosen = hoverIndex !== undefined ? skills[hoverIndex] : undefined;
    closeBloom();
    if (url && chosen) {
      reading.classList.add("bean-reading--open");
      window.bean.planFromDrop(chosen.name, url);
      // ponytail: fixed cosmetic delay standing in for a real "reading the page" step;
      // swap for a real fetch/summarize call if that ever gets built.
      setTimeout(() => reading.classList.remove("bean-reading--open"), 700);
    } else if (url) {
      void window.bean.openComponent("chat", url); // no petal chosen — today's fallback
    }
  });

  // Fallback path: the bloom never opened (e.g. zero skills configured) — same behavior
  // as before this feature existed.
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (mode === "drag") return; // the bloom's own drop handler already covers this
    const url = dataUrl(e);
    if (url) void window.bean.openComponent("chat", url);
  });
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/renderer/avatar.ts
git commit -m "feat(app): wire the drag-to-skill-bloom interaction into the avatar"
```

---

### Task 8: Final gate, manual verification, memory update

**Files:**
- Modify: `.memory/safety-window-behavior.md`

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: exit 0 (core: `drop-plan.test.ts` + existing suites; app: `petal-geometry.test.ts`,
rewritten `avatar-menu.test.ts`, + existing suites — all pass).

- [ ] **Step 2: Run the full typecheck**

Run: `pnpm typecheck`
Expected: exit 0 for both packages.

- [ ] **Step 3: Run the full build**

Run: `pnpm build`
Expected: exit 0. Spot-check the new outputs exist:
```bash
ls packages/app/dist/renderer/plan.html
ls packages/app/dist/renderer/components/plan/index.js
ls packages/app/dist/renderer/drag-bloom.css
```

- [ ] **Step 4: Manual walkthrough via `pnpm dev`**

Run `pnpm dev` and, with `~/.bean/skills/*.md` and `~/.bean/projects.json` populated with at
least 3 skills and 2 projects (one project's `defaultSkill` matching one of the skills),
walk every bullet in the design doc's §7 checklist
(`docs/superpowers/specs/2026-07-01-bean-drag-skill-bloom-design.md`):

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
- With `~/.bean/skills` emptied out temporarily: dragging a URL onto Bean never blooms;
  behaves exactly like today (opens Chat with the URL).
- Toggle Hearth/Graphite from any window: the Plan window and the bloom petals restyle
  correctly in both.
- Confirm a plan from the Plan window: Chat window opens/focuses and its console shows the
  run's live output; the Plan window's button shows "Running…".
- Bubble menu (dblclick) still opens/closes normally; dragging a URL while the bubble menu
  is open does not bloom.

Record which bullets pass. If this environment has no GUI-automation capability (consistent
with every prior sub-project in this codebase — see the playbook's SP3/SP4/SP7/SP8 notes),
report exactly that live drag-and-drop needs a human/GUI-capable session, same as those
prior items, rather than claiming it was exercised.

- [ ] **Step 5: Record the window-mode + run-wiring notes in memory**

Modify `.memory/safety-window-behavior.md` — append these two paragraphs at the end of the
file (after the existing "Theme state lives in `main.ts`" paragraph):

```markdown

**The avatar now has a third grown size, for the drag-to-skill-bloom interaction.**
`AvatarMode` (`channels.ts`) is `"normal" | "menu" | "drag"`; `avatar-menu.ts`'s
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
```

- [ ] **Step 6: Commit**

```bash
git add .memory/safety-window-behavior.md
git commit -m "docs(memory): record the avatar drag-mode and plan-window run-wiring notes"
```
