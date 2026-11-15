import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Project } from "./types.js";

export async function loadProjects(file: string): Promise<Project[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? foldDefaultSkills(parsed as LegacyProject[]) : [];
  } catch {
    return [];
  }
}

export async function saveProjects(file: string, projects: Project[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(projects, null, 2) + "\n", "utf8");
}

/** A project as an older file or shell may still carry it: with the retired single `defaultSkill`. */
export type LegacyProject = Project & { defaultSkill?: unknown };

/** Moves each retired `defaultSkill` into its project's `skills` — only when no project lists that
 * skill yet, first in file order — and drops the field. `bestProjectForSkill` resolves the same
 * project before and after (it used to check every `skills` first, then the first `defaultSkill`). */
export function foldDefaultSkills(projects: LegacyProject[]): Project[] {
  const listed = new Set(projects.flatMap((p) => p.skills ?? []));
  return projects.map(({ defaultSkill, ...p }) => {
    if (typeof defaultSkill !== "string" || !defaultSkill || listed.has(defaultSkill)) return p;
    listed.add(defaultSkill);
    return { ...p, skills: [...(p.skills ?? []), defaultSkill] };
  });
}
