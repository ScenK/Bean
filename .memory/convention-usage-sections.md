# convention: usage sections are derived, display-only

The Skills/Sprouts lists are sectioned by usage (epic #878) with pure helpers in
`core/src/usage-sections.ts` (renderer: `@bean/core/usage-sections`). Nothing is stored except
the optional `Routine.projects`.

- `Skill.usedBy` is set only by the host's `listSkills` (local IPC and the remote wire). Absent =
  unknown (sprouts unreadable via `loadRoutines(dir, true)`, or an older core) — never send `[]`
  for that, or sprout-only skills get misfiled; consumers fall back to the flat list.
  `usedByOff` (#1035) is the subset whose sprout is `enabled: false`, set and omitted together with
  `usedBy`. A disabled skill warns (red) only for enabled sprouts; off ones get a neutral
  `↻ <sprout> (off) — fails if run` chip.
- `sproutProblems()`'s `disabled-skill` (step skill exists but is off) is a row note / `⚠` only —
  never Needs fixing. Needs fixing is `isFolderProblem` (folder kinds listed explicitly); the
  runtime throw in `routine-runner.ts` is still the only block.
- `Routine.projects` is display only: never a cwd, command, permission or recipient. Unknown
  paths stay in the file and are ignored for sectioning; `[]` is stored as absent. Every path that
  rewrites a sprout must keep it — spreads do; an owner's chat replacement copies it over from
  the saved sprout (`bot.ts`), since the draft tool has no such field.
- `sproutProblems()` needs the **full** skill catalog (hidden + disabled), or a hidden step skill
  reads as missing. The renderer's `listSkills` omits hidden skills, so it isn't that catalog.
- Folder matching is segment-boundary prefix, innermost project wins (`projectForFolder`).
- Skills window (`SkillsPanel.tsx`): `hasUsage()` false (any skill without `usedBy`) renders the
  flat list. Open sections live in localStorage `bean.skills.openSections` (default: Skills only);
  a toggle that moves the selected skill opens its new section and scrolls it into view.
  e2e: `skills-sections.e2e.ts`.
- Sprouts window (`RoutinesPanel.tsx` + `routines/sprout-sections.ts`): Needs fixing (a folder
  problem; never also in Scratch), projects A–Z (one row per project, `also:` names the rest),
  Scratch. Folded keys in localStorage `bean.routines.foldedSections` (project path, `""` =
  Scratch, `!needs-fixing`; default all open). Listed under edits only the draft (saves with the
  sprout). Register folder re-reads `listProjects` before appending. The renderer has no hidden
  skills, so a hidden step skill reads "not found" (muted note only). e2e: `routines-sections.e2e.ts`.
  Archived (#983) is last and only for sprouts whose `routinesState` carries `ended.archived` —
  the host computes `endedView()` in core time (never the renderer clock), so a remote shell lists
  the same. It is folded by default, so its `!archived` key in that list means *open*. Restore opens
  the editor with `until` cleared and `enabled` on; Save goes through the host's restore path.
  While restoring, nothing saves early (type change stays local; switching off drops the restore).
  The host refuses a later end on an ended sprout saved while still off — the next Enable would
  skip the restore and a watch would keep its old seen-set (chat-card replacements save off with
  the old end and let `enableWatch` commit the new one). The 5s poll re-reads definitions when the
  ended set changes; an edited draft keeps its edits and takes only `enabled`/`until`. A remote shell
  gets the Sprouts list read-only (`routinesList`/`State`/`Builds` in `REMOTE_OPS`, no Restore shown);
  every write stays local. The draft's baseline after an own save is the draft that was saved
  (`markSaved`), never a cleared one; Restore from the sprout's own editor keeps its edits.
- Projects window (`ProjectsPanel.tsx` + `projects/project-members.ts`): row shows `n skills · m
  sprouts`; SKILLS edits the project's `skills` (re-reads `listProjects` before `saveProjects`, so it
  agrees with the Skills window's chips); SPROUTS is `sproutProjects()` membership, never written
  onto `Project`. `routinesList` isn't a remote op, so a failed/non-array listing omits SPROUTS
  (and the row's sprout count). e2e: `component-windows.e2e.ts`.
- Bots' `sprouts` reply (`routineListText`, #885): same section order, but each sprout once —
  Needs fixing (folder problem), else its first project in registry order (`· also` the rest),
  else Scratch; `⚠` marker per problem with folder basenames only. Free text goes through
  `inert()` (one line, markdown escaped, `@` defused) — never print a path in a channel.

Related: [[convention-hidden-skills]], [[convention-renderer-imports-node-free-subpaths]].
