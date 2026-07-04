import { composePrompt } from "./prompt.js";
import { bestProjectForSkill } from "./project-select.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";

// ponytail: naive project match, no model call — same "hardcode it, revisit the real
// inference later" call made for the avatar's best-guess petal badge (see the drag-bloom
// design doc, packages/app side). Upgrade path: a real route()-style model call once this
// needs to be smarter than bestProjectForSkill's fixed priority order.
export function planForDroppedSkill(
  skillName: string,
  droppedUrl: string,
  skills: Skill[],
  projects: Project[],
): RouteSuggestion {
  const skill = skills.find((s) => s.name === skillName);
  const project = bestProjectForSkill(skillName, projects);
  return {
    skillName: skill?.name ?? skillName,
    projectPath: project?.path ?? "",
    composedPrompt: skill ? composePrompt(skill, "Handle the linked page.", droppedUrl) : droppedUrl,
    confidence: 0,
    target: skill?.target,
  };
}
