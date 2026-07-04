# Built-in skills: project `.bean` extended by user `~/.bean`

## Problem

Today every skill (and persona) lives only in `~/.bean`, which the user hand-populates. There's
no way to ship default skills with the app itself, and no way to distinguish "Bean's built-in
skill" from "something I wrote."

## Goal

Add a second, lower-priority skill/persona source at `<repo-root>/.bean` (committed to git, the
skills Bean ships with). `~/.bean` extends it: a user file with the same name overrides the
built-in one; anything only in one of the two dirs still shows up. Writes (save/delete/enable
toggle) always target `~/.bean` only — editing a built-in forks it into the user dir.

## Non-goals

- `projects.json` and `config.json` (API key) are per-machine and have no sensible repo default —
  not part of this change.
- No N-layer plugin system — exactly two fixed layers (project, user).

## Design

### Locating the project `.bean` dir

`packages/core/src/config.ts` gains:

```ts
export function projectBeanDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", ".bean");
}
```

`config.ts` compiles flat (`rootDir: src` → `outDir: dist`, no subfolders), so this file always
lives at `packages/core/{src,dist}/config.js` — three directories up reaches the repo root in
both the vitest (src) and built (dist) case identically. No new dependency, no packaging
assumption beyond "this monorepo's directory shape doesn't change."

### Layered skill loading

`packages/core/src/skill-library.ts` gains:

```ts
export async function loadLayeredSkills(projectDir: string, userDir: string): Promise<Skill[]>
```

Loads both dirs with the existing `loadSkills()` (unchanged, still directly unit-tested as a
plain single-dir reader), merges by filename — a user skill replaces a project skill of the same
name — and tags each result `source: "project" | "user"` reflecting which layer is currently in
effect. Union of non-colliding names from both dirs. A missing project dir behaves like today
(empty contribution, no error).

`Skill` (in `types.ts`) gains an optional `source?: "project" | "user"` field. Additive only —
`route()`, `converse()`, and existing tests that don't care about it are unaffected.

### Layered persona

`packages/core/src/persona-store.ts`'s `loadPersona` gains an optional second argument:

```ts
export async function loadPersona(file: string, fallbackFile?: string): Promise<Persona>
```

Tries `file`, then `fallbackFile` (if given and valid), then `DEFAULT_PERSONA` — same override-by-
presence idea as skills, just for one JSON file. Calling with one argument is unchanged behavior
(existing tests keep passing).

### Writes stay user-only

`saveSkill` / `deleteSkill` / `savePersona` are untouched — always target the user dir/file.
Consequences:
- Editing a built-in skill in the Skills panel writes a same-named file into `~/.bean/skills`,
  which then wins the merge (fork-on-edit) — no new code path needed.
- Deleting a *forked* skill removes only the user copy; the built-in underneath reappears on the
  next load automatically, because the merge always re-reads both dirs.
- Deleting a *pure* built-in (no user copy exists yet) would call `deleteSkill` on a file that
  isn't there — already a documented no-op today. Rather than let that look like a silent failure,
  the Skills panel disables the Delete button for skills whose `source === "project"`, with a
  tooltip explaining they're built-in (edit to fork, then delete the fork).

### Wiring changes (`packages/app`)

- `main.ts`: compute `const projectDir = projectBeanDir();` once at startup; pass
  `skillsDir(projectDir)` / `personaFile(projectDir)` alongside the existing user-dir paths;
  swap the `loadSkills` import for `loadLayeredSkills`; update the one direct call inside
  `planFromDrop`.
- `ipc.ts`: `RouteHandlerDeps`, `ChatHandlerDeps`, `ListSkillsHandlerDeps` change `loadSkills:
  (dir) => Promise<Skill[]>` + `skillsDir` to `loadSkills: (projectDir, userDir) =>
  Promise<Skill[]>` + a new `projectSkillsDir` field; their handlers call
  `deps.loadSkills(deps.projectSkillsDir, deps.skillsDir)`. `PersonaHandlerDeps`/`RegisterDeps`
  add `projectPersonaFile` and call `deps.loadPersona(deps.personaFile,
  deps.projectPersonaFile)`. `SaveSkillHandlerDeps` / `DeleteSkillHandlerDeps` are untouched
  (still single `skillsDir`, the user dir).
- `SkillsPanel.tsx`: small "Built-in" badge when `source === "project"`; Delete disabled +
  tooltip for pure built-ins; footer path hint mentions both dirs.
- `index.ts` (core barrel): export `projectBeanDir` and `loadLayeredSkills`.

### Seed content

`<repo-root>/.bean/skills/` is created and populated with the user's four current skills, copied
in as the initial built-in set: `code-review.md`, `scaffold-feature.md`, `triage-issues.md`,
`write-tests.md`.

## Testing

- `skill-library.test.ts`: `loadLayeredSkills` — user overrides project by name, non-colliding
  names from both are unioned, missing project dir behaves like today, `source` tagging is
  correct on both sides of an override.
- `config.test.ts`: `projectBeanDir()` returns `<repo-root>/.bean` (computed, not hardcoded).
- `persona-store.test.ts`: fallback param — user file wins, falls back to project file, falls
  back further to `DEFAULT_PERSONA`; no-fallback-arg call keeps old behavior.
- `ipc.test.ts`: update the existing `loadSkills`/`loadPersona`/`skillsDir` call sites for the new
  two-arg shapes and the added `projectSkillsDir` / `projectPersonaFile` fields.
