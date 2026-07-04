# convention: `Project.skills` vs `Project.defaultSkill`

`Project` (`packages/core/src/types.ts`) has two skill-related fields that look similar but
serve **unrelated** purposes — don't conflate or merge them:

- **`defaultSkill?: string`** — a single best-guess fallback name, consumed by
  `router.ts`/`drop-plan.ts`/`avatar.ts` heuristics ("no model match → try this skill").
  Pre-existing, untouched by the skills-grouping feature.
- **`skills?: string[]`** — explicit many-to-many assignment: which skills the Skills panel
  groups under this project. A skill name can appear in multiple projects' `skills` arrays
  (assigned to several projects at once); a skill in **no** project's `skills` array renders
  under the panel's "General" group. Toggled from `SkillsPanel.tsx`'s per-project checkbox
  list via the existing `saveProjects()` round-trip — no new IPC channel was needed for
  assignment, only for `deleteSkill` (`bean:delete-skill`).

**Gotcha already hit once:** any code that rebuilds a `Project` object from its edit-form
fields (e.g. `ProjectsPanel.tsx`'s `saveEdit`) must carry over the original `skills` array —
it's not part of the edit form, so it's easy to accidentally drop when reconstructing the
object from `{ name, path, defaultSkill }` alone.

**Gotcha #2, already hit once too:** "which project owns this skill" was independently
duplicated in `drop-plan.ts` (drag-drop-onto-petal), `SkillsPanel.tsx`'s Run button, and
`avatar.ts`'s petal "best guess" badge — and only some of them checked `skills` before
`defaultSkill`, so dropping a URL on a skill could resolve to a different project than
clicking "Run skill" on that same skill. Fixed by centralizing the resolution order in
`bestProjectForSkill()` (`packages/core/src/project-select.ts`, exported both from the main
barrel for core/main-process code and via the node-free `@bean/core/project-select` subpath
for renderer code — same pattern as `persona.ts`/`@bean/core/persona`). **Any new surface that
needs to pick a project for a skill name must call this helper, not re-derive the fallback
chain.** Priority: `Project.skills` match → `Project.defaultSkill` match → `projects[0]`.
Similarly, both the drop flow and the Skills panel's manual Run now build the initial prompt
via the same `composePrompt()` (also exposed via `@bean/core/prompt` for the renderer) so the
proposal textarea always starts from the same shape (skill body, then an optional `## Task`
section only when there's an instruction) regardless of which flow triggered it.
