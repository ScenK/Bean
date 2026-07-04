import type { Skill } from "./types.js";

export function composePrompt(skill: Skill, instruction: string, url?: string): string {
  const parts = [skill.body.trim()];
  const task = instruction.trim();
  if (task) parts.push("", `## Task`, task);
  if (url && url.trim()) {
    parts.push("", `## Context URL`, url.trim());
  }
  return parts.join("\n");
}
