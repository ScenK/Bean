import type { Project, Routine } from "@bean/core";
import { isFolderProblem, sproutProblems, sproutProjects, trimSlashes, type SproutProblem } from "@bean/core/usage-sections";

// The Sprouts list's sections (#883): Needs fixing, then registered projects A–Z, then Scratch,
// then Archived (#983). Derived on every render from the saved sprouts, the registry and the
// core's archived set; nothing here is stored.

/** Section keys double as the fold keys in localStorage: a project's path (stable — names repeat
 * and get renamed), `""` for Scratch, `NEEDS_FIXING` for Needs fixing. */
export const NEEDS_FIXING = "!needs-fixing";
export const SCRATCH = "";
/** Folded by default, so its fold key in localStorage marks it *open*. */
export const ARCHIVED = "!archived";

export interface SproutRow { routine: Routine; also: string[]; problems: SproutProblem[] }
export interface SproutSection { key: string; label: string; rows: SproutRow[] }

/** An archived sprout (`archived`, the core's derived set) goes only under Archived. Otherwise: a
 * sprout with a folder problem goes under Needs fixing; one listed under (or whose steps start
 * in) projects goes under each of them, `also` naming the others; anything else under Scratch.
 * `skillNames` should be the full catalog, or a hidden step skill reads as missing; `disabledSkills`
 * its `enabled: false` names (a muted note, never Needs fixing). Empty sections
 * are dropped; rows keep `routines` order. */
export function sproutSections(routines: readonly Routine[], projects: readonly Project[], skillNames: ReadonlySet<string>, archived: ReadonlySet<string> = new Set(), disabledSkills: ReadonlySet<string> = new Set()): SproutSection[] {
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const sections: SproutSection[] = [
    { key: NEEDS_FIXING, label: "Needs fixing", rows: [] },
    ...sorted.map((p) => ({ key: p.path, label: p.name, rows: [] as SproutRow[] })),
    { key: SCRATCH, label: "Scratch", rows: [] },
    { key: ARCHIVED, label: "Archived", rows: [] },
  ];
  const byKey = new Map(sections.map((s) => [s.key, s]));
  for (const routine of routines) {
    if (archived.has(routine.name)) {
      byKey.get(ARCHIVED)!.rows.push({ routine, also: [], problems: [] });
      continue;
    }
    const problems = sproutProblems(routine, projects, skillNames, disabledSkills);
    const homes = sproutProjects(routine, projects);
    const names = homes.map((p) => p.name);
    if (problems.some(isFolderProblem)) byKey.get(NEEDS_FIXING)!.rows.push({ routine, also: names, problems });
    for (const p of homes) byKey.get(p.path)?.rows.push({ routine, also: names.filter((n) => n !== p.name), problems });
    if (homes.length === 0 && !problems.some(isFolderProblem)) byKey.get(SCRATCH)!.rows.push({ routine, also: [], problems });
  }
  return sections.filter((s) => s.rows.length > 0);
}

/** Where a sprout with no Listed under goes — the editor's "Follows its steps → …" hint. */
export function derivedSectionLabel(routine: Routine, projects: readonly Project[]): string {
  const { projects: _listed, ...rest } = routine;
  if (sproutProblems(rest, projects, new Set()).some(isFolderProblem)) return "Needs fixing";
  const homes = sproutProjects(rest, projects);
  return homes.length > 0 ? homes.map((p) => p.name).join(", ") : "Scratch";
}

const trim = trimSlashes;
export const isListedUnder = (routine: Routine, path: string): boolean =>
  routine.projects?.some((p) => trim(p) === trim(path)) ?? false;

/** Toggles one registered path in `routine.projects`; unknown paths already there are kept, and
 * an emptied list drops the key (`[]` is stored as absent). */
export function toggleListedUnder(routine: Routine, path: string): Routine {
  const { projects: current = [], ...rest } = routine;
  const next = isListedUnder(routine, path) ? current.filter((p) => trim(p) !== trim(path)) : [...current, path];
  return next.length > 0 ? { ...rest, projects: next } : rest;
}

/** The project name a registered folder gets: its last path segment. */
export const folderName = (folder: string): string => trim(folder).split("/").pop() || folder;
