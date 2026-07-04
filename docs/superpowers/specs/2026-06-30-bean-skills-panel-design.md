# Bean — Dashboard Redesign, Sub-Project 4: Skills Panel — Design

Date: 2026-06-30
Status: Approved for planning
Depends on: [2026-06-30-bean-command-bar-chat-design.md](2026-06-30-bean-command-bar-chat-design.md) (SP2, complete — reuses its proposal/confirm flow)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Turn the placeholder Skills panel into a browse / view / run / edit surface over
`~/.bean/skills/*.md`. `@bean/core` already has everything needed to *read* skills
(`loadSkills`, the `Skill` type) but nothing is exposed to the renderer, and nothing can
*write* a skill back. SP4 adds the missing read/write IPC surface and a two-pane panel
(name list left, detail right) matching the mockup, with two actions:

- **Run skill** — resolves a project, builds a `RouteSuggestion`, and drops it into the
  existing Chat panel as a pending proposal card (SP2's `ProposalCard`/`confirmProposal`
  flow, unchanged). No new run path.
- **Edit .md** — swaps the detail pane into an in-panel textarea over the skill's raw body,
  with Save/Cancel. Save writes the file via a new `saveSkill` IPC call.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Run skill action | Sends to chat as a pending proposal (reuses `ProposalCard`/`confirmProposal`); no self-contained inline run form. |
| Edit .md action | In-panel textarea editor with Save/Cancel (not shell-out to the OS default editor). |
| Data access | Two new read-only IPC endpoints, `listSkills` and `listProjects`, rather than one combined endpoint. `listProjects` also sets up SP6's Projects panel. |
| Save failure UX | Inline error line under the editor; the user's draft is kept (not discarded) so no edits are lost. |
| Project resolution for Run skill | First project whose `defaultSkill === skill.name`, else `projects[0]`; button disabled (with a title tooltip) if no projects are loaded. |
| Composed prompt default | Empty string — the user fills in intent in the confirm card's existing editable textarea, same as any chat-originated proposal. |
| Concurrent-edit / locking | None — single local user, last-write-wins (ponytail: acceptable for a local desktop tool). |

## 3. Scope

**In scope:**
- `@bean/core`: `saveSkill(dir, name, body): Promise<void>` in `skill-library.ts`.
- New IPC channels: `listSkills`, `listProjects`, `saveSkill` — channel definitions in
  `channels.ts`, handlers in `ipc.ts`, wiring in `main.ts`, exposure in `preload.ts` +
  `bean.d.ts`.
- `SkillsPanel`: stateful — fetches skills + projects on mount, renders the name list +
  detail pane (view/edit modes), wires Run skill / Edit .md / Save / Cancel.
- `App`: adds an `onRunSkill` handler that appends a proposal `ChatItem`, passed to
  `SkillsPanel`.
- CSS for the two-pane layout, name list rows (selected state), and the edit-mode textarea
  — reusing existing `.bean-card`/`.bean-btn` primitives where they fit.

**Out of scope (deferred):**
- Creating/deleting skill files — only edit existing ones.
- Any project **picker** in the UI — project resolution is automatic (see table above). The
  confirm card (`ProposalCard`) never exposed project editing for chat-originated proposals
  either, so this introduces no new gap. If manual project override turns out to matter, add
  a selector in a later pass.
- Live filesystem watching (`~/.bean/skills/*.md` changing externally while the panel is
  open) — the list only refreshes on mount and after a successful save.
- Skill validation/linting (missing description, malformed frontmatter) — `loadSkills`
  already degrades gracefully (empty description); the panel just displays whatever it gets.

## 4. Architecture

### 4.1 Core: `saveSkill` (packages/core/src/skill-library.ts)

```ts
export async function saveSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}
```

Mirrors `project-registry.ts`'s `saveProjects` mkdir-then-write pattern. `name` is always a
value already produced by `loadSkills` (`basename(file, ".md")`), so no path-traversal
handling is needed beyond what `join` already does for a plain filename segment. Exported
from `packages/core/src/index.ts` alongside `loadSkills`.

### 4.2 IPC surface

`channels.ts` — add to `IPC`:
```ts
listSkills: "bean:list-skills",
listProjects: "bean:list-projects",
saveSkill: "bean:save-skill",
```

`ipc.ts` — new handler builders alongside the existing `buildRouteHandler`/`buildChatHandler`,
reusing the same deps already on `RegisterDeps` (`loadSkills`, `loadProjects`, `skillsDir`,
`projectsFile`) plus one new dep:

```ts
export interface RegisterDeps extends RouteHandlerDeps, ThemeHandlerDeps {
  // ...existing fields...
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
}
```

```ts
ipcMain.handle(IPC.listSkills, () => deps.loadSkills(deps.skillsDir));
ipcMain.handle(IPC.listProjects, () => deps.loadProjects(deps.projectsFile));
ipcMain.handle(IPC.saveSkill, (_e, name: string, body: string) =>
  deps.saveSkill(deps.skillsDir, name, body),
);
```

`main.ts` passes the real `saveSkill` from `@bean/core` into `registerIpc`, same import
style as `loadSkills`/`loadProjects`.

`preload.ts` / `bean.d.ts` — add:
```ts
listSkills(): Promise<Skill[]>;
listProjects(): Promise<Project[]>;
saveSkill(name: string, body: string): Promise<void>;
```

### 4.3 Renderer: `SkillsPanel` (packages/app/src/renderer/dashboard/panels/SkillsPanel.tsx)

Props: `{ onRunSkill: (run: RouteSuggestion) => void }`.

State:
- `skills: Skill[]`, `projects: Project[]` — fetched via `Promise.all([window.bean.listSkills(), window.bean.listProjects()])` in a mount `useEffect`.
- `selectedName: string | undefined` — set to `skills[0]?.name` once skills load.
- `mode: "view" | "edit"`.
- `draft: string` — the textarea's live value, only populated when entering edit mode.
- `saveError: string | undefined`.

Behavior:
- **Selecting a skill** (click a row in the left pane): sets `selectedName`; if `mode === "edit"`, discard the draft and return to `"view"` (switching skills mid-edit abandons the edit — no cross-skill draft juggling).
- **Left pane**: one row per skill (`skill.name`), highlighted if `name === selectedName`.
  Empty skills list → the panel's existing `.bean-panel-empty` message ("Skills browsing is
  coming in a later build." is replaced with something like "No skills found —
  ~/.bean/skills/*.md").
- **Right pane, view mode**: skill name (heading), `description`, a small monospace preview
  block, `Run skill` button, `Edit .md` button.
- **Run skill** (enabled only if `projects.length > 0`): compute
  `project = projects.find(p => p.defaultSkill === skill.name) ?? projects[0]`, build
  `{ skillName: skill.name, projectPath: project.path, composedPrompt: "", confidence: 1 }`,
  call `onRunSkill(run)`. Button is `disabled` with `title="No projects configured"` when
  `projects.length === 0`.
- **Edit .md**: `mode = "edit"`, `draft = skill.body`, `saveError = undefined`.
- **Right pane, edit mode**: a `<textarea>` bound to `draft`, `Save` and `Cancel` buttons, and
  (if `saveError`) an inline error line below the textarea.
  - **Cancel**: `mode = "view"`, discard `draft`, clear `saveError`.
  - **Save**: `await window.bean.saveSkill(skill.name, draft)`; on success, refetch
    `listSkills()`, set `mode = "view"`, clear `saveError` (the just-saved skill stays
    selected by name — `selectedName` doesn't change, it's independent of array index);
    on rejection, set `saveError = err.message` and stay in edit mode with `draft` intact.

### 4.4 `App` wiring (packages/app/src/renderer/dashboard/App.tsx)

Add:
```ts
const runSkill = (run: RouteSuggestion): void => {
  setItems((prev) => [...prev, { kind: "proposal", id: newId(), run, state: "pending" }]);
};
```
Pass `onRunSkill={runSkill}` to `<SkillsPanel>`. This is the exact same `ChatItem` shape
SP2's chat-originated proposals use, so `ProposalCard`/`confirmProposal` need no changes —
confirming it calls `window.bean.run(...)` exactly as today.

### 4.5 CSS (packages/app/src/renderer/dashboard.css)

Add: a two-pane flex layout for the panel body (`~42%`/`flex:1`, matching the mockup's
proportions), name-list row + selected-row styling, and edit-mode textarea sizing. Reuse
existing `.bean-btn`/`.bean-btn--ghost`/`.bean-chip` primitives for buttons/chips rather than
inventing new ones. Follow existing `.bean-*` naming and SP1 theme-variable conventions.

## 5. Error handling

- `listSkills`/`listProjects` returning `[]` (missing dir/file, already handled by the
  existing core functions) → panel renders its empty state; `Run skill` is simply disabled
  if projects are empty.
- `saveSkill` rejecting (permission error, disk full, etc.) → inline error under the
  textarea, draft preserved, user can retry Save or Cancel.
- No project matches a skill's `defaultSkill` and no projects exist at all → `Run skill`
  disabled (covered above); if projects exist but none match, `projects[0]` is used as the
  fallback (no error state needed — it's always resolvable when `projects.length > 0`).

## 6. Testing

**Core (`packages/core/__test__/skill-library.test.ts`, extending the existing file):**
- `saveSkill` writes the file at `<dir>/<name>.md` with the exact body given.
- `saveSkill` creates the skills directory if it doesn't exist yet.
- A round trip — `saveSkill` then `loadSkills` — returns the new content (`body` matches,
  `description` reflects the saved frontmatter/heading).

**IPC (`packages/app/__test__/ipc.test.ts` or wherever `buildRouteHandler`/`buildChatHandler`
are currently tested — extend the same file):**
- `listSkills` handler calls `deps.loadSkills(deps.skillsDir)` and returns its result.
- `listProjects` handler calls `deps.loadProjects(deps.projectsFile)` and returns its result.
- `saveSkill` handler calls `deps.saveSkill(deps.skillsDir, name, body)` with the given args.

**Renderer:** no automated DOM tests (SP1–SP3 constraint — no DOM test infra). Verified
manually via `pnpm dev` per the checklist below.

**Gate:** `pnpm test && pnpm typecheck` from the repo root must both exit 0 before done.

## 7. Manual verification checklist (for the plan's final task)

- Open the dashboard with at least two skills under `~/.bean/skills/*.md` → the left pane
  lists them, the first is selected by default, and the right pane shows its name,
  description, and preview.
- Click a different skill → the right pane updates; if mid-edit, the edit is abandoned and
  the view reverts.
- Click `Run skill` on a skill whose owning project has `defaultSkill` set to it → a pending
  proposal card appears in the Chat panel with the expected `skillName`/`projectPath`, an
  empty editable prompt; confirming it runs exactly as a chat-originated proposal would
  (streams into the Console panel per SP3).
- Click `Run skill` on a skill with no matching `defaultSkill` project → the proposal uses
  `projects[0]`.
- With `~/.bean/projects.json` empty/missing → `Run skill` is disabled.
- Click `Edit .md`, change the body, click `Save` → the file on disk is updated, the panel
  returns to view mode showing the new description/preview.
- Click `Edit .md`, change the body, click `Cancel` → the file on disk is unchanged, the
  panel shows the original content.
- Force a save failure (e.g. `chmod`-protect the skill file) → an inline error appears, the
  edited draft remains in the textarea, and a subsequent Save retry is possible.
- With no skills present (`~/.bean/skills/` empty or missing) → the panel shows its empty
  state instead of an empty list.
- Toggle Hearth/Graphite → the panel restyles like other panels (no dark-locked body, unlike
  the Console panel).

## 8. Risks / open questions

- **No live directory watching:** if a skill file is edited externally (another app, `git
  pull`, etc.) while the dashboard is open, the panel won't see it until next mount or the
  next save-triggered refetch. Acceptable for a local single-user tool; add a watcher only if
  this becomes a real annoyance.
- **`defaultSkill` matching is exact-string:** if a project's `defaultSkill` doesn't exactly
  match a skill's filename-derived `name` (e.g. stale config after a rename), Run skill
  silently falls back to `projects[0]` rather than surfacing the mismatch. Consistent with
  how `route()` already resolves skills/projects elsewhere in the codebase — not a new
  failure mode introduced by this SP.
- **No project picker on the confirm card:** if `projects[0]`/`defaultSkill` resolution picks
  the "wrong" project, the user's only recourse today is to cancel the proposal and drive it
  through chat instead (where the router picks a project) or edit `~/.bean/projects.json`.
  Flagged as a possible follow-up, not blocking for SP4.
</content>
