import { expect, test } from "vitest";
import { projectBeanDir, skillsDir } from "../src/config.js";
import { loadSkills } from "../src/skill-library.js";

test("ships the built-in skills at <repo-root>/.bean/skills", async () => {
  const skills = await loadSkills(skillsDir(projectBeanDir()));
  expect(skills.map((s) => s.name).sort()).toEqual([
    "draft-reply", "explain", "extract-tasks", "summarize"
  ]);
});

test("built-in content skills are chat-target", async () => {
  const skills = await loadSkills(skillsDir(projectBeanDir()));
  for (const name of ["summarize", "explain", "draft-reply", "extract-tasks"]) {
    expect(skills.find((s) => s.name === name)?.target, name).toBe("chat");
  }
});
