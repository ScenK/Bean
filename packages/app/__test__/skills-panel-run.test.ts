import { expect, test } from "vitest";
import type { Project, Skill } from "@bean/core";
import { runForSkill } from "../src/renderer/components/skills/SkillsPanel.js";

const skill: Skill = { name: "deploy", description: "d", body: "BODY" };
const p = (name: string, extra: Partial<Project> = {}): Project => ({ name, path: `/p/${name}`, ...extra });

test("Run on an unlinked skill opens the Plan card with no project (scratch), even with projects configured", () => {
  expect(runForSkill(skill, [p("a"), p("b"), p("c")])).not.toHaveProperty("projectPath");
  expect(runForSkill(skill, [])).not.toHaveProperty("projectPath");
});

test("Run on a linked skill picks its project", () => {
  expect(runForSkill(skill, [p("a"), p("b", { defaultSkill: "deploy" })]).projectPath).toBe("/p/b");
  expect(runForSkill(skill, [p("a", { defaultSkill: "deploy" }), p("b", { skills: ["deploy"] })]).projectPath).toBe("/p/b");
});
