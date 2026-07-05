import type { Skill } from "./types.js";
import { stripFrontmatter } from "./frontmatter.js";

export function composePrompt(skill: Skill, instruction: string, url?: string): string {
  // Frontmatter is Bean metadata (target/enabled/description) — never part of the prompt.
  const parts = [stripFrontmatter(skill.body).trim()];
  const task = instruction.trim();
  if (task) parts.push("", `## Task`, task);
  if (url && url.trim()) {
    parts.push("", `## Context URL`, url.trim());
  }
  return parts.join("\n");
}
