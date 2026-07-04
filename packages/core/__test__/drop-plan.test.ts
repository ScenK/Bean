import { expect, test } from "vitest";
import { planForDroppedSkill } from "../src/drop-plan.js";
import type { Project, Skill } from "../src/types.js";

const skills: Skill[] = [
  { name: "triage-issues", description: "reproduce + plan", body: "TRIAGE BODY" },
  { name: "write-tests", description: "cover the fix", body: "TEST BODY" },
];
const projects: Project[] = [
  { name: "api", path: "/dev/api", defaultSkill: "triage-issues" },
  { name: "core", path: "/dev/core" },
];

test("matches the project whose defaultSkill equals the dropped skill", () => {
  const plan = planForDroppedSkill("triage-issues", "https://jira/PROJ-1", skills, projects);
  expect(plan.skillName).toBe("triage-issues");
  expect(plan.projectPath).toBe("/dev/api");
  expect(plan.composedPrompt).toContain("TRIAGE BODY");
  expect(plan.composedPrompt).toContain("https://jira/PROJ-1");
  expect(plan.confidence).toBe(0);
});

test("falls back to the first project when no defaultSkill matches", () => {
  const plan = planForDroppedSkill("write-tests", "https://x", skills, projects);
  expect(plan.skillName).toBe("write-tests");
  expect(plan.projectPath).toBe("/dev/api");
});

test("degrades gracefully when the skill name no longer matches any loaded skill", () => {
  const plan = planForDroppedSkill("nonexistent-skill", "https://x", skills, projects);
  expect(plan.skillName).toBe("nonexistent-skill");
  expect(plan.projectPath).toBe("/dev/api");
  expect(plan.composedPrompt).toBe("https://x");
});

test("carries the skill's chat target onto the suggestion", () => {
  const chatSkills: Skill[] = [{ name: "summarize", description: "s", body: "B", target: "chat" }];
  const plan = planForDroppedSkill("summarize", "https://x", chatSkills, projects);
  expect(plan.target).toBe("chat");
  expect(planForDroppedSkill("triage-issues", "https://x", skills, projects).target).toBeUndefined();
});
