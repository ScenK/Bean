import type { Routine } from "./routine-store.js";
import type { Project, Skill } from "./types.js";

// Pure derivations for the usage-sectioned Skills/Sprouts lists (#878). Node-free (type-only
// imports) — the renderer imports it as `@bean/core/usage-sections`. Display only: nothing here
// picks a cwd, a command, a permission or a recipient.

/** Skill name → names of the saved sprouts whose delegate/chat steps name it (each sprout once,
 * in `routines` order; disabled sprouts included). Flat `steps[]` — every step, any branch.
 * `onlyOff`: count only `enabled: false` sprouts (the host's `usedByOff`). */
export function skillUsage(routines: readonly Routine[], onlyOff = false): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of routines) {
    if (onlyOff && r.enabled) continue;
    for (const s of r.steps) {
      if (!s.skill) continue;
      const names = out.get(s.skill) ?? [];
      if (!names.includes(r.name)) names.push(r.name);
      out.set(s.skill, names);
    }
  }
  return out;
}

export type SkillSection = "disabled" | "sprout-steps" | "skills";

/** Exactly one section per skill: disabled → sprout-only (used by a sprout, off the avatar, in no
 * project's `skills`) → skills. An absent `usedBy` (unknown) never files a skill as sprout-only. */
export function skillSection(
  skill: Pick<Skill, "name" | "enabled" | "quickLaunch" | "usedBy">, projects: readonly Project[],
): SkillSection {
  if (skill.enabled === false) return "disabled";
  if ((skill.usedBy?.length ?? 0) > 0 && skill.quickLaunch === false && !projects.some((p) => p.skills?.includes(skill.name))) {
    return "sprout-steps";
  }
  return "skills";
}

const trim = (p: string): string => p.replace(/\/+$/, "") || "/";
/** `folder` is `base` or below it, on a path-segment boundary (`/w/app` holds `/w/app/sub`, not `/w/application`). */
const within = (folder: string, base: string): boolean => {
  const f = trim(folder);
  const b = trim(base);
  return f === b || f.startsWith(b === "/" ? "/" : `${b}/`);
};

/** The registered project holding `folder` — the longest (innermost) match; first in file order on a tie. */
export function projectForFolder(folder: string, projects: readonly Project[]): Project | undefined {
  let best: Project | undefined;
  for (const p of projects) {
    if (within(folder, p.path) && (!best || trim(p.path).length > trim(best.path).length)) best = p;
  }
  return best;
}

/** `routine.projects` narrowed to registered paths (registry order); unknown paths are ignored, never dropped from the file. */
const listedProjects = (routine: Routine, projects: readonly Project[]): Project[] =>
  routine.projects?.length ? projects.filter((p) => routine.projects!.some((x) => trim(x) === trim(p.path))) : [];

const stepFolders = (routine: Routine): { step: number; folder: string }[] =>
  routine.steps.flatMap((s, i) => (s.kind !== "chat" && s.project ? [{ step: i + 1, folder: s.project }] : []));

/** The projects a sprout is listed under: its registered `projects`; else the projects holding
 * its steps' folders (registry order); `[]` = Scratch. */
export function sproutProjects(routine: Routine, projects: readonly Project[]): Project[] {
  const listed = listedProjects(routine, projects);
  if (listed.length > 0) return listed;
  const held = new Set(stepFolders(routine).map((s) => projectForFolder(s.folder, projects)).filter((p) => p !== undefined));
  return projects.filter((p) => held.has(p));
}

/** `step` is 1-based. `unregistered-folder`/`ancestor-folder` only when the sprout has no
 * registered `projects` (setting it is the fix); `ancestor-folder` = the folder sits above
 * registered projects (never offer to register it). */
export type SproutProblem =
  | { kind: "unregistered-folder"; step: number; folder: string }
  | { kind: "ancestor-folder"; step: number; folder: string }
  | { kind: "missing-skill"; step: number; skill: string }
  | { kind: "disabled-skill"; step: number; skill: string };

/** The folder kinds — the ones that file a sprout under Needs fixing. Skill problems never do. */
export const isFolderProblem = (p: SproutProblem): boolean => p.kind === "unregistered-folder" || p.kind === "ancestor-folder";

/** `skillNames` must be the full catalog — hidden and disabled skills included — or a hidden
 * step skill reads as missing. `disabledSkills`: the catalog's `enabled: false` names; a step
 * naming one is `disabled-skill` (missing wins). */
export function sproutProblems(
  routine: Routine, projects: readonly Project[], skillNames: ReadonlySet<string>, disabledSkills: ReadonlySet<string> = new Set(),
): SproutProblem[] {
  const out: SproutProblem[] = [];
  if (listedProjects(routine, projects).length === 0) {
    for (const { step, folder } of stepFolders(routine)) {
      if (projectForFolder(folder, projects)) continue;
      const ancestor = projects.some((p) => within(p.path, folder));
      out.push({ kind: ancestor ? "ancestor-folder" : "unregistered-folder", step, folder });
    }
  }
  routine.steps.forEach((s, i) => {
    if (!s.skill) return;
    if (!skillNames.has(s.skill)) out.push({ kind: "missing-skill", step: i + 1, skill: s.skill });
    else if (disabledSkills.has(s.skill)) out.push({ kind: "disabled-skill", step: i + 1, skill: s.skill });
  });
  return out.sort((a, b) => a.step - b.step);
}
