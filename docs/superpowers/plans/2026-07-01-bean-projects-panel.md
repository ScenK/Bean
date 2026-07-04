# SP6 Projects Panel (list-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Bean's placeholder Projects & Tasks panel into a real, read-only list of the projects configured in `~/.bean/projects.json` — name, path, and a badge for `defaultSkill` when set — matching the left column of the mockup's "Projects & Tasks" panel.

**Architecture:** No core or IPC changes — `window.bean.listProjects()` already exists (shipped in SP4) and is the only data source this panel needs. `ProjectsPanel` becomes stateful (fetch on mount) and renders a static row list. No selection, no actions, no callbacks into `App.tsx`.

**Tech Stack:** TypeScript (ESM), `@bean/app` (Electron, esbuild, Preact).

**Spec:** [docs/superpowers/specs/2026-07-01-bean-projects-panel-design.md](../specs/2026-07-01-bean-projects-panel-design.md)

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected (`.memory/convention-core-is-electron-free.md`) — **not touched by this plan**, no new IO needed.
- IPC channel names live only in `packages/app/src/channels.ts`, referenced via `IPC.*` (`.memory/convention-ipc-channels.md`) — **no new channels added**; this plan only consumes the existing `IPC.listProjects`.
- ESM everywhere: `.js` extensions in relative imports; `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` + `noUncheckedIndexedAccess` are on — array access is `T | undefined`; handle it.
- No new test-framework dependency; renderer UI is verified manually via `pnpm dev` (no DOM test infra in this repo, per SP1–SP5 precedent).
- This SP is **list-only** — no launcher buttons, no task monitor, no add/edit/remove-project UI. That work is deferred to a future SP7 with its own design pass.
- Requires Node ≥24, pnpm 11, `opencode` on `PATH`.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0.

---

### Task 1: `ProjectsPanel` component + styling (`@bean/app`)

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx` (replace the placeholder)
- Modify: `packages/app/src/renderer/dashboard.css`

**Interfaces:**
- Consumes: `window.bean.listProjects(): Promise<Project[]>` (already exists — `packages/app/src/renderer/bean.d.ts:17`, wired since SP4); `Project` type from `@bean/core` (`{ name: string; path: string; defaultSkill?: string }`).
- Produces: nothing downstream — `ProjectsPanel` keeps its existing no-props signature, so `App.tsx`'s current `<ProjectsPanel />` call (line 119) needs no change.

- [x] **Step 1: Replace `ProjectsPanel.tsx`**

Overwrite `packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`:
```tsx
import { useEffect, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import type { Project } from "@bean/core";

export function ProjectsPanel() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    void window.bean.listProjects().then(setProjects);
  }, []);

  if (projects.length === 0) {
    return (
      <div class="bean-panel bean-panel--wide">
        <PanelHeader title="Projects & Tasks" />
        <div class="bean-panel-empty">No projects configured — add entries to ~/.bean/projects.json</div>
      </div>
    );
  }

  return (
    <div class="bean-panel bean-panel--wide">
      <PanelHeader title="Projects & Tasks" />
      <div class="bean-projects-list">
        {projects.map((p) => (
          <div key={p.path} class="bean-projects-row">
            <span class="bean-projects-name">{p.name}</span>
            <span class="bean-projects-path">{p.path}</span>
            {p.defaultSkill ? <span class="bean-chip">{p.defaultSkill}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [x] **Step 2: Append project list styles**

Append to the end of `packages/app/src/renderer/dashboard.css`:
```css
/* --- projects (SP6) --- */
.bean-projects-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 16px;
  overflow-y: auto;
}
.bean-projects-row {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--bean-border);
  border-radius: 10px;
  padding: 9px 12px;
}
.bean-projects-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--bean-text);
}
.bean-projects-path {
  font: 11px ui-monospace, monospace;
  color: var(--bean-text-dim);
  flex: 1;
}
```

- [x] **Step 3: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0. `ProjectsPanel` keeps its no-props signature, so `App.tsx`'s existing `<ProjectsPanel />` call is untouched and still typechecks.

- [x] **Step 4: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx packages/app/src/renderer/dashboard.css
git commit -m "feat(app): build read-only ProjectsPanel list view"
```

---

### Task 2: Full validation + manual verification + ledger update

**Files:**
- Modify: `docs/superpowers/bean-redesign-playbook.md` (status ledger — SP6 row + new SP7 row)
- Modify: `.memory/project-dashboard-redesign-roadmap.md` (status line)
- Check off completed step boxes in this plan file and in Task 1 above.

**Interfaces:**
- Consumes: Task 1's `ProjectsPanel`.
- Produces: nothing downstream (terminal task in this plan).

- [x] **Step 1: Run the full repo gate**

Run:
```bash
pnpm test && pnpm typecheck
```
Expected: both turbo tasks succeed, exit 0. (No new tests were added — this SP touches only renderer UI — so this step confirms nothing else regressed.)

- [x] **Step 2: Manual walkthrough via `pnpm dev`**

Requires `~/.bean/projects.json` with at least 2 entries, at least one with `defaultSkill` set and one without. Run:
```bash
pnpm dev
```
Verify each, checking the box only after observing it:
- [ ] The Projects panel lists every project from `~/.bean/projects.json`.
- [ ] The project with `defaultSkill` set shows a badge with that skill's name; the one without shows no badge.
- [ ] With `~/.bean/projects.json` emptied or renamed away → the panel shows its empty state ("No projects configured — add entries to ~/.bean/projects.json").
- [ ] Toggling Hearth/Graphite (title-bar button) restyles the Projects panel like other panels.
- [ ] Shrinking the dashboard window with many projects configured scrolls the list rather than overflowing the panel.

> If your environment cannot exercise interactive GUI verification (no screenshot/automation tool), note that explicitly and confirm via a static code review of `ProjectsPanel.tsx` against this checklist instead — same substitution SP3/SP4's manual steps used when no GUI tool was available.

> **Actual (this session, left unchecked above — not observed via GUI):** this session has no
> Electron GUI-automation/screenshot tool, so the interactive checklist bullets above were not
> clicked through and are left unchecked rather than guessed — same substitution SP3/SP4 used.
> Confirmed instead via: (1) `pnpm test && pnpm typecheck` (Step 1) both exit 0; (2) static
> review of the committed `ProjectsPanel.tsx` — it maps every entry in the fetched `projects`
> array to a row (line 25), renders `p.defaultSkill` as a `.bean-chip` only when truthy (line
> 29, ternary — no chip element at all when unset, matching "shows no badge"), falls back to
> the existing `.bean-panel-empty` block when `projects.length === 0` (line 12-19, exact copy
> text matches), and uses only theme CSS variables (`--bean-border`/`--bean-text`/
> `--bean-text-dim`) with no hardcoded colors, consistent with every other themeable panel; (3)
> `.bean-projects-list` has `overflow-y: auto` (dashboard.css), matching the scroll behavior
> `.bean-skills-list` already uses. Real `~/.bean/projects.json` on this machine has two
> entries, neither with `defaultSkill` set, so the "one badge / one no-badge" case specifically
> was verified via code logic rather than an observed screenshot. A human (or an agent with
> display/automation access) should still click through this checklist before considering SP7
> or any further dashboard work fully signed off on the visual layer.

- [x] **Step 3: Update the status ledger**

In `docs/superpowers/bean-redesign-playbook.md`, change the SP6 row from:
```markdown
| 6 | Projects & Tasks: project list + multi-launcher (`opencode run` / `claude -p` / `open` / `shell`) + live subprocess monitor. Biggest net-new scope; needs a dedicated design pass beyond today's single `runOpencode` path. | — | — | ⬜ not started |
```
to:
```markdown
| 6 | Projects panel (list-only): read-only project list (name, path, `defaultSkill` badge) using the existing `listProjects` IPC. | `specs/2026-07-01-bean-projects-panel-design.md` | `plans/2026-07-01-bean-projects-panel.md` | ✅ done + reviewed |
| 7 | Multi-launcher + task monitor: `opencode run` / `claude -p` / `open` / `shell` per project, plus a live subprocess monitor. Split out of SP6 during brainstorming pending a design rethink; needs its own spec/plan. | — | — | ⬜ not started |
```

- [x] **Step 4: Update the roadmap memory**

In `.memory/project-dashboard-redesign-roadmap.md`, update the "Status at last update" text to reflect SP6 complete as a list-only panel reusing SP4's `listProjects` IPC with no new core/IPC surface, and that the mockup's four-mode launcher + task monitor was split out into a new SP7 (not yet designed) after the user opted to defer that design during brainstorming.

- [x] **Step 5: Check off this plan's step boxes**

Mark every completed `- [ ]` in this plan file as `- [x]`, and in Task 1 above.

- [x] **Step 6: Commit**

```bash
git add docs/superpowers/bean-redesign-playbook.md .memory/project-dashboard-redesign-roadmap.md docs/superpowers/plans/2026-07-01-bean-projects-panel.md
git commit -m "docs(sp6): mark projects panel done, split launcher into SP7"
```

---

## Self-Review

**Spec coverage:**
- §4.1 `ProjectsPanel` (fetch on mount, row rendering, badge-only-when-set, empty state) → Task 1.
- §4.2 CSS (`.bean-projects-list`/`.bean-projects-row`/`.bean-projects-name`/`.bean-projects-path`, reusing existing `.bean-chip`) → Task 1.
- §4.3 "No `App.tsx` changes" → Task 1's Interfaces note and Step 3's expected-output note both call this out explicitly; no task touches `App.tsx`.
- §4.4 "No IPC/core changes" → Global Constraints states it; no task touches `packages/core/` or `channels.ts`/`ipc.ts`/`preload.ts`.
- §5 error handling (empty list → empty state, no explicit try/catch needed) → Task 1's implementation.
- §6 testing (no new automated tests; gate must still pass) → Task 2 Step 1.
- §7 manual checklist → Task 2 Step 2 (every bullet from the spec's checklist is reproduced).
- §8 SP7 hand-off note → Task 2 Step 3 (new ledger row) and Step 4 (roadmap memory).

**Placeholder scan:** none — both code steps show full file content; commands and expected outputs are concrete; ledger/memory updates show exact before/after text.

**Type consistency:** `Project` (`{ name: string; path: string; defaultSkill?: string }`) used identically in Task 1's `ProjectsPanel` as everywhere else in the codebase (`SkillsPanel.tsx`, `project-registry.ts`, `types.ts`) — no new type introduced. `window.bean.listProjects()` return type (`Promise<Project[]>`) matches `bean.d.ts:17` exactly, unchanged by this plan.
</content>
