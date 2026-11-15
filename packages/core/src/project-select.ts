import type { Project } from "./types.js";

// Shared resolution order for "which project owns this skill", used by every surface that
// needs to pick a project for a skill name without the user explicitly choosing one
// (drag-drop-onto-petal, the Skills panel's Run, the chat's /skill). Keeping this in one place
// is the fix for a real bug: drop-plan.ts and the Skills panel used to duplicate slightly
// different fallback chains, so the same skill could land in different projects.
//
// The first project (file order) whose `skills` lists the name. No match = undefined: an
// unlinked skill runs in the scratch workspace, never silently in whichever project is listed first.
export function bestProjectForSkill(skillName: string, projects: Project[]): Project | undefined {
  return projects.find((p) => p.skills?.includes(skillName));
}

// Display order only — desktop panels list projects A–Z. Never feed this into
// bestProjectForSkill or a "first project" fallback: those resolve in file order.
export const projectsByName = (projects: Project[]): Project[] =>
  [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
