# convention: `Project.skills` is the only project↔skill link (`defaultSkill` is retired)

`Project.skills?: string[]` (`packages/core/src/types.ts`) is many-to-many: a skill name can be
in several projects' lists. It is set from the Skills panel's per-project checkboxes via the
`saveProjects()` round-trip. The old single `defaultSkill` field was removed (#879).

- **Legacy files/shells:** `foldDefaultSkills()` (`core/src/project-registry.ts`) runs in
  `loadProjects` (never rewrites the file on read) and again in the host's `saveProjects`
  handler (an older shell can still send the field — the IPC `shape` guard passes unlisted
  keys). It moves a `defaultSkill` into that project's `skills` only when no project lists the
  skill yet, first in file order, so resolution is unchanged.
- **Save prunes dangling names:** the `saveProjects` handler drops `skills` entries with no
  skill file in the full layered catalog (hidden and disabled count). An empty catalog read
  prunes nothing — it may be a failed read.
- **One resolver:** "which project owns this skill" is `bestProjectForSkill()`
  (`core/src/project-select.ts`, also the node-free `@bean/core/project-select` subpath for the
  renderer): the first project in **file order** whose `skills` lists it, else `undefined`
  (scratch workspace; never `projects[0]` — #586). Drop-plan, the Skills panel's Run, the chat's
  `/skill`, and the avatar's "best guess" all go through it. Don't re-derive it; don't feed it
  `projectsByName()` (display order only).
- **Gotcha already hit once:** code that rebuilds a `Project` from an edit form
  (`ProjectsPanel.tsx`'s `saveEdit`) must carry over the original `skills` — it isn't in the form.
- Drop and Run build the initial prompt with the same `composePrompt()` (`@bean/core/prompt`).
