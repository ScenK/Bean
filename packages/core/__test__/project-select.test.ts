import { expect, test } from "vitest";
import { bestProjectForSkill, projectsByName } from "../src/project-select.js";
import type { Project } from "../src/types.js";

test("prefers a project whose skills array includes the name", () => {
  const projects: Project[] = [
    { name: "api", path: "/dev/api", defaultSkill: "write-tests" },
    { name: "web", path: "/dev/web", skills: ["review-code"] },
  ];
  expect(bestProjectForSkill("review-code", projects)?.path).toBe("/dev/web");
});

test("falls back to defaultSkill match when no skills array matches", () => {
  const projects: Project[] = [
    { name: "api", path: "/dev/api", defaultSkill: "write-tests" },
    { name: "web", path: "/dev/web" },
  ];
  expect(bestProjectForSkill("write-tests", projects)?.path).toBe("/dev/api");
});

test("an unlinked skill gets no project (scratch), not the first one", () => {
  const projects: Project[] = [
    { name: "api", path: "/dev/api" },
    { name: "web", path: "/dev/web" },
  ];
  expect(bestProjectForSkill("nonexistent", projects)).toBeUndefined();
});

test("skills array takes priority even when defaultSkill points elsewhere", () => {
  const projects: Project[] = [
    { name: "api", path: "/dev/api", defaultSkill: "review-code" },
    { name: "web", path: "/dev/web", skills: ["review-code"] },
  ];
  expect(bestProjectForSkill("review-code", projects)?.path).toBe("/dev/web");
});

test("returns undefined when there are no projects", () => {
  expect(bestProjectForSkill("review-code", [])).toBeUndefined();
});

test("projectsByName sorts A–Z ignoring case without mutating the input", () => {
  const projects: Project[] = [{ name: "web", path: "/w" }, { name: "Zed", path: "/z" }, { name: "api", path: "/a" }];
  expect(projectsByName(projects).map((p) => p.name)).toEqual(["api", "web", "Zed"]);
  expect(projects.map((p) => p.name)).toEqual(["web", "Zed", "api"]);
});
