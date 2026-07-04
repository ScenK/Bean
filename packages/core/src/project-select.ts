import type { Project } from "./types.js";

// Shared resolution order for "which project owns this skill", used by every surface that
// needs to pick a project for a skill name without the user explicitly choosing one
// (drag-drop-onto-petal, and the Skills panel's "General" row Run). Keeping this in one place
// is the fix for a real bug: drop-plan.ts and the Skills panel used to duplicate slightly
// different fallback chains, so dropping a URL on a skill could land in a different project
// than clicking "Run skill" on that same (unassigned) skill would.
//
// Priority: explicit multi-project assignment (Project.skills, set via the Skills panel's
// "assign to projects" checkboxes) > legacy single defaultSkill badge > first configured project.
export function bestProjectForSkill(skillName: string, projects: Project[]): Project | undefined {
  return projects.find((p) => p.skills?.includes(skillName))
    ?? projects.find((p) => p.defaultSkill === skillName)
    ?? projects[0];
}
