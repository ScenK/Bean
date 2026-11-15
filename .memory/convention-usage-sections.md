# convention: usage sections are derived, display-only

The Skills/Sprouts lists are sectioned by usage (epic #878) with pure helpers in
`core/src/usage-sections.ts` (renderer: `@bean/core/usage-sections`). Nothing is stored except
the optional `Routine.projects`.

- `Skill.usedBy` is set only by the host's `listSkills` (local IPC and the remote wire). Absent =
  unknown (sprouts unreadable via `loadRoutines(dir, true)`, or an older core) — never send `[]`
  for that, or sprout-only skills get misfiled; consumers fall back to the flat list.
- `Routine.projects` is display only: never a cwd, command, permission or recipient. Unknown
  paths stay in the file and are ignored for sectioning; `[]` is stored as absent. Every path that
  rewrites a sprout must keep it — spreads do; an owner's chat replacement copies it over from
  the saved sprout (`bot.ts`), since the draft tool has no such field.
- `sproutProblems()` needs the **full** skill catalog (hidden + disabled), or a hidden step skill
  reads as missing. The renderer's `listSkills` omits hidden skills, so it isn't that catalog.
- Folder matching is segment-boundary prefix, innermost project wins (`projectForFolder`).

Related: [[convention-hidden-skills]], [[convention-renderer-imports-node-free-subpaths]].
