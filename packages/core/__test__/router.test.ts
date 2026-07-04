import { expect, test } from "vitest";
import { route } from "../src/router.js";
import type { Skill, Project } from "../src/types.js";

const skills: Skill[] = [
  { name: "review-code", description: "review", body: "REVIEW BODY" },
  { name: "investigate", description: "investigate", body: "INVESTIGATE BODY" },
];
const projects: Project[] = [
  { name: "acme", path: "/dev/acme", defaultSkill: "review-code" },
  { name: "bean", path: "/dev/bean" },
];

test("uses model choice and composes prompt from local skill body", async () => {
  const chat = async () =>
    JSON.stringify({ skillName: "review-code", projectPath: "/dev/acme", confidence: 0.9 });
  const s = await route(
    { userText: "review this", droppedUrl: "https://jira/X-1" },
    skills, projects, { chat, model: "gpt-4o-mini" },
  );
  expect(s.skillName).toBe("review-code");
  expect(s.projectPath).toBe("/dev/acme");
  expect(s.confidence).toBe(0.9);
  expect(s.composedPrompt).toContain("REVIEW BODY");
  expect(s.composedPrompt).toContain("review this");
  expect(s.composedPrompt).toContain("https://jira/X-1");
});

test("falls back to confidence 0 on garbage model output", async () => {
  const chat = async () => "not json";
  const s = await route({ userText: "x" }, skills, projects, { chat, model: "m" });
  expect(s.confidence).toBe(0);
  expect(s.projectPath).toBe("/dev/acme");
  expect(s.skillName).toBe("review-code");
});

test("falls back to confidence 0 when model returns literal null", async () => {
  const chat = async () => "null";
  const s = await route({ userText: "x" }, skills, projects, { chat, model: "m" });
  expect(s.confidence).toBe(0);
  expect(s.projectPath).toBe("/dev/acme");
  expect(s.skillName).toBe("review-code");
});

test("falls back when model names unknown skill/project", async () => {
  const chat = async () =>
    JSON.stringify({ skillName: "nope", projectPath: "/nowhere", confidence: 0.8 });
  const s = await route({ userText: "x" }, skills, projects, { chat, model: "m" });
  expect(s.confidence).toBe(0);
  expect(s.projectPath).toBe("/dev/acme");
});
