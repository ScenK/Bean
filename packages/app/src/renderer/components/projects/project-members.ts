import type { Project, Routine } from "@bean/core";
import { sproutProjects } from "@bean/core/usage-sections";

// The Projects window's per-project members (#884). Sprouts are derived for display only and
// never written onto a `Project`; skills are the project's own `skills` list.

/** Project path → names of the sprouts the Sprouts window lists under that project. */
export function sproutsByProject(routines: readonly Routine[], projects: readonly Project[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of routines) {
    for (const p of sproutProjects(r, projects)) out.set(p.path, [...(out.get(p.path) ?? []), r.name]);
  }
  return out;
}

/** Adds (`on`) or removes `skill` in the project at `path`; an emptied list drops the key. */
export function withProjectSkill(projects: readonly Project[], path: string, skill: string, on: boolean): Project[] {
  return projects.map((p) => {
    if (p.path !== path) return p;
    const { skills = [], ...rest } = p;
    const next = on ? (skills.includes(skill) ? skills : [...skills, skill]) : skills.filter((s) => s !== skill);
    return next.length > 0 ? { ...rest, skills: next } : rest;
  });
}

export const countOf = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
