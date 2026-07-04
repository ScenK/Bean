import { composePrompt } from "./prompt.js";
import type { Project, RouteInput, RouteSuggestion, Skill } from "./types.js";

export interface ChatMsg { role: "system" | "user"; content: string; }
export interface RouterDeps {
  chat: (args: { model: string; messages: ChatMsg[] }) => Promise<string>;
  model: string;
}

function buildMessages(input: RouteInput, skills: Skill[], projects: Project[]): ChatMsg[] {
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const projectList = projects.map((p) => `- ${p.name} (${p.path})`).join("\n");
  return [
    {
      role: "system",
      content:
        "You route a user request to one skill and one project. " +
        "Reply ONLY with JSON: {\"skillName\":string,\"projectPath\":string,\"confidence\":number}. " +
        "skillName must be one of the listed skill names; projectPath must be one of the listed project paths.",
    },
    {
      role: "user",
      content:
        `Skills:\n${skillList}\n\nProjects:\n${projectList}\n\n` +
        `Request: ${input.userText}\n` +
        (input.droppedUrl ? `URL: ${input.droppedUrl}\n` : ""),
    },
  ];
}

export async function route(
  input: RouteInput,
  skills: Skill[],
  projects: Project[],
  deps: RouterDeps,
): Promise<RouteSuggestion> {
  const fallbackProject = projects[0];
  const fallbackSkill =
    skills.find((s) => s.name === fallbackProject?.defaultSkill) ?? skills[0];

  const compose = (skill: Skill | undefined, projectPath: string, confidence: number): RouteSuggestion => ({
    skillName: skill?.name ?? "",
    projectPath,
    composedPrompt: skill ? composePrompt(skill, input.userText, input.droppedUrl) : input.userText,
    confidence,
  });

  let parsed: { skillName?: string; projectPath?: string; confidence?: number };
  try {
    const raw = await deps.chat({ model: deps.model, messages: buildMessages(input, skills, projects) });
    parsed = JSON.parse(raw);
  } catch {
    return compose(fallbackSkill, fallbackProject?.path ?? "", 0);
  }
  if (!parsed || typeof parsed !== "object") {
    return compose(fallbackSkill, fallbackProject?.path ?? "", 0);
  }

  const skill = skills.find((s) => s.name === parsed.skillName);
  const project = projects.find((p) => p.path === parsed.projectPath);
  if (!skill || !project) {
    return compose(fallbackSkill, fallbackProject?.path ?? "", 0);
  }
  return compose(skill, project.path, typeof parsed.confidence === "number" ? parsed.confidence : 0);
}
