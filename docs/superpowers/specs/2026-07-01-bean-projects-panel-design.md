# Bean — Dashboard Redesign, Sub-Project 6: Projects Panel (list-only) — Design

Date: 2026-07-01
Status: Approved for planning
Depends on: [2026-06-30-bean-skills-panel-design.md](2026-06-30-bean-skills-panel-design.md) (SP4 — added the `listProjects` IPC endpoint this SP reuses as-is)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Turn the placeholder Projects & Tasks panel into a real, read-only list of the projects in
`~/.bean/projects.json`, matching the left column of the mockup's "Projects & Tasks" panel
(project name, path, and a badge for its `defaultSkill` when set).

This is deliberately the **list half only** of the mockup's panel. The mockup also shows a
right-hand "LAUNCH" column (four buttons: `opencode run` / `claude -p` / `open` / `shell`)
plus a live subprocess/task monitor card. That is real net-new scope — a general subprocess
launcher beyond today's single `runOpencode()` path — and its design was explicitly deferred
by the user during brainstorming pending a rethink. It becomes its own future sub-project
(tracked as **SP7** in the playbook ledger), not part of this spec.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Scope | List-only. No launcher, no task monitor, no new IPC/core changes — everything needed (`listProjects`) already shipped in SP4. |
| Data source | `window.bean.listProjects()`, fetched once on mount — same pattern `SkillsPanel` already uses. |
| Interactivity | None — rows are static display, no selection/detail pane (unlike Skills, there is nothing to view/run/edit here yet). |
| Badge | Shown only when `project.defaultSkill` is set; omitted entirely otherwise (no "none" placeholder). |
| Empty state | Reuse the existing `.bean-panel-empty` convention, text pointing at `~/.bean/projects.json`. |
| Follow-up scope (launcher + task monitor) | Deferred to a new sub-project, not designed here. Ledger updated to show SP6 rescoped to list-only and add a new `⬜` SP7 row. |

## 3. Scope

**In scope:**
- `ProjectsPanel` (`packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx`): fetches
  projects on mount via `window.bean.listProjects()` and renders one row per project.
- CSS for the row list (`packages/app/src/renderer/dashboard.css`), reusing the existing
  `.bean-skills-list`/`.bean-skills-row`-style primitives and the existing `.bean-chip` badge
  class — no new visual primitives invented.
- Updating the playbook ledger (§1 table) and roadmap memory to reflect SP6 = list-only,
  done, and a new SP7 row for the deferred launcher/task-monitor work.

**Out of scope (deferred to SP7, not designed in this spec):**
- The four-mode launcher (`opencode run` / `claude -p` / `open` / `shell`).
- Any new subprocess/task data model, IPC, or generalization of `runOpencode()`.
- A live task/subprocess monitor card.
- Adding/editing/removing projects from the UI (mockup shows no such affordance either —
  `projects.json` remains hand-edited, same as today).

## 4. Architecture

### 4.1 Renderer: `ProjectsPanel` (packages/app/src/renderer/dashboard/panels/ProjectsPanel.tsx)

No props needed (no parent state depends on it — unlike `SkillsPanel`, there is no
`onRunSkill`-style callback since there is no action here yet).

State:
- `projects: Project[]` — fetched via `window.bean.listProjects()` in a mount `useEffect`.

Rendering:
- `projects.length === 0` → the panel's existing `.bean-panel-empty` slot, text: `"No
  projects configured — add entries to ~/.bean/projects.json"`.
- Otherwise → `.bean-panel--wide` (kept from the SP1 placeholder) containing a
  `.bean-projects-list` of rows, one per `Project`:
  - `.bean-projects-name` — `project.name`, bold.
  - `.bean-projects-path` — `project.path`, muted monospace.
  - `.bean-chip` (existing class) showing `project.defaultSkill`, rendered only when
    `project.defaultSkill` is truthy.

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

This is the plan's reference implementation; the plan will TDD it via a small renderer smoke
check if the existing test setup supports one (see §6), otherwise it's manual-only like
`SkillsPanel`/`PersonaPanel`'s view rendering.

### 4.2 CSS (packages/app/src/renderer/dashboard.css)

Add, adjacent to the existing `.bean-skills-*` block:

```css
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

`.bean-chip` (badge) already exists and needs no changes. No new theme variables — reuses
`--bean-border`, `--bean-text`, `--bean-text-dim` from SP1's theme system.

### 4.3 No `App.tsx` changes

`ProjectsPanel` is already mounted in `App.tsx` with no props (`<ProjectsPanel />`); nothing
there needs to change since this panel has no callbacks or shared state.

### 4.4 No IPC/core changes

`window.bean.listProjects()`, its IPC channel, handler, and `loadProjects` core function all
already exist and are exercised by `SkillsPanel` today — this SP is purely a renderer
consumer of an existing surface.

## 5. Error handling

- `listProjects` returning `[]` (missing/invalid `~/.bean/projects.json` — already handled by
  the existing `loadProjects`, which degrades to `[]` on any read/parse failure) → empty
  state, no error surfaced (consistent with how `SkillsPanel` treats an empty skills list).
- `window.bean.listProjects()` rejecting: not expected — the underlying IPC handler
  (`buildListProjectsHandler`) never throws (its only failure mode, a bad JSON file, is
  already swallowed inside `loadProjects`). No explicit try/catch added, consistent with
  `SkillsPanel`'s treatment of the same call.

## 6. Testing

**Core / IPC:** none needed — no new core or IPC code in this SP.

**Renderer:** no automated DOM tests (established SP1–SP5 constraint — no DOM test infra in
this repo). Verified manually via `pnpm dev` per the checklist below.

**Gate:** `pnpm test && pnpm typecheck` from the repo root must both exit 0 before done (this
SP doesn't add tests, but the gate still confirms nothing else regressed).

## 7. Manual verification checklist (for the plan's final task)

- With `~/.bean/projects.json` containing 2+ projects (at least one with `defaultSkill` set,
  one without) → the panel lists all of them; the one with `defaultSkill` shows a badge, the
  other doesn't.
- With `~/.bean/projects.json` missing or an empty array → the panel shows its empty state.
- Toggle Hearth/Graphite → the panel restyles like other panels.
- Resize the dashboard window → the list scrolls rather than overflowing if there are many
  projects (sanity check on `overflow-y: auto`).

## 8. Risks / open questions

- **No live file watching:** editing `~/.bean/projects.json` while the dashboard is open
  requires a dashboard reopen/reload to see changes — same accepted limitation as
  `SkillsPanel`'s skill list (SP4 §8).
- **SP7 (launcher + task monitor) is unscoped:** this spec intentionally does not attempt to
  design the four-mode launcher or task monitor. Whoever picks up SP7 should treat the
  mockup's right-hand "LAUNCH" column as the starting reference and re-run the brainstorming
  gate fresh — key open questions noted during this SP's brainstorm: how many of the four
  launch modes get real subprocess execution vs. OS-level delegation (`open`/`shell`), and
  whether the task monitor needs to track more than one concurrent run.
</content>
