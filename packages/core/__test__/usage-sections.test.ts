import { describe, expect, it } from "vitest";
import type { Routine } from "../src/routine-store.js";
import type { Project, Skill } from "../src/types.js";
import { projectForFolder, skillSection, skillUsage, sproutProblems, sproutProjects, trimSlashes } from "../src/usage-sections.js";

const sprout = (name: string, steps: Routine["steps"], over: Partial<Routine> = {}): Routine =>
  ({ name, enabled: true, cron: "0 8 * * *", steps, sinks: {}, ...over });
const delegate = (skill: string, project?: string): Routine["steps"][number] =>
  ({ kind: "delegate", skill, instruction: "go", ...(project ? { project } : {}) });
const projects: Project[] = [
  { name: "app", path: "/w/app", skills: ["linked"] },
  { name: "inner", path: "/w/app/pkg" },
  { name: "application", path: "/w/application" },
  { name: "lib", path: "/w/lib/" },
];

describe("skillUsage", () => {
  it("names each sprout once per skill, from delegate and chat steps, disabled sprouts included", () => {
    const usage = skillUsage([
      sprout("a", [delegate("x"), delegate("x"), { kind: "chat", skill: "y", instruction: "c" }, { kind: "command", command: "ls" }]),
      sprout("b", [delegate("x")], { enabled: false }),
    ]);
    expect(Object.fromEntries(usage)).toEqual({ x: ["a", "b"], y: ["a"] });
  });
});

describe("skillSection", () => {
  const base: Skill = { name: "s", description: "", body: "" };
  it("puts every skill in exactly one section", () => {
    expect(skillSection({ ...base, enabled: false, usedBy: ["a"], quickLaunch: false }, projects)).toBe("disabled");
    expect(skillSection({ ...base, usedBy: ["a"], quickLaunch: false }, projects)).toBe("sprout-steps");
    expect(skillSection({ ...base, usedBy: ["a"] }, projects)).toBe("skills"); // on the avatar
    expect(skillSection({ ...base, name: "linked", usedBy: ["a"], quickLaunch: false }, projects)).toBe("skills"); // in a project
    expect(skillSection({ ...base, usedBy: [], quickLaunch: false }, projects)).toBe("skills"); // chat & bots only
    expect(skillSection({ ...base, quickLaunch: false }, projects)).toBe("skills"); // usedBy unknown
  });
});

describe("projectForFolder", () => {
  it("matches on segment boundaries and picks the innermost project", () => {
    expect(projectForFolder("/w/app", projects)?.name).toBe("app");
    expect(projectForFolder("/w/app/sub/", projects)?.name).toBe("app");
    expect(projectForFolder("/w/application/x", projects)?.name).toBe("application");
    expect(projectForFolder("/w/app/pkg/src", projects)?.name).toBe("inner");
    expect(projectForFolder("/w/lib", projects)?.name).toBe("lib"); // trailing slash on the registered path
    expect(projectForFolder("/w/ap", projects)).toBeUndefined();
    expect(projectForFolder("/w", projects)).toBeUndefined();
  });
});

describe("sproutProjects", () => {
  it("uses registered `projects`, ignoring unknown paths", () => {
    const r = sprout("a", [delegate("x", "/w/app")], { projects: ["/w/lib", "/gone"] });
    expect(sproutProjects(r, projects).map((p) => p.name)).toEqual(["lib"]);
  });
  it("falls back to the steps' folders when every listed path is stale", () => {
    const r = sprout("a", [delegate("x", "/w/app/sub"), delegate("x", "/w/application")], { projects: ["/gone"] });
    expect(sproutProjects(r, projects).map((p) => p.name)).toEqual(["app", "application"]);
  });
  it("is [] (Scratch) with no step folder, or only unregistered ones", () => {
    expect(sproutProjects(sprout("a", [delegate("x")]), projects)).toEqual([]);
    expect(sproutProjects(sprout("a", [delegate("x", "/elsewhere")]), projects)).toEqual([]);
    expect(sproutProjects(sprout("a", [delegate("x", "/w/app")]), [])).toEqual([]);
  });
});

describe("sproutProblems", () => {
  const skills = new Set(["x", "hidden-skill"]);
  it("flags an unregistered or ancestor step folder only without registered `projects`", () => {
    const r = sprout("a", [delegate("x", "/elsewhere"), delegate("x", "/w"), delegate("x", "/w/app")]);
    expect(sproutProblems(r, projects, skills)).toEqual([
      { kind: "unregistered-folder", step: 1, folder: "/elsewhere" },
      { kind: "ancestor-folder", step: 2, folder: "/w" },
    ]);
    expect(sproutProblems({ ...r, projects: ["/w/app"] }, projects, skills)).toEqual([]);
    expect(sproutProblems({ ...r, projects: ["/gone"] }, projects, skills)).toHaveLength(2);
  });
  it("flags a step skill with no file; a hidden one in the catalog is not missing", () => {
    const r = sprout("a", [delegate("hidden-skill"), { kind: "chat", skill: "nope", instruction: "c" }, { kind: "command", command: "ls" }]);
    expect(sproutProblems(r, projects, skills)).toEqual([{ kind: "missing-skill", step: 2, skill: "nope" }]);
  });
  it("flags a step skill that is switched off; missing wins over disabled (#1035)", () => {
    const r = sprout("a", [delegate("x"), { kind: "chat", skill: "nope", instruction: "c" }]);
    expect(sproutProblems(r, projects, skills, new Set(["x", "nope"]))).toEqual([
      { kind: "disabled-skill", step: 1, skill: "x" },
      { kind: "missing-skill", step: 2, skill: "nope" },
    ]);
  });
  it("skillUsage onlyOff counts only off sprouts", () => {
    const rs = [sprout("on", [delegate("x")]), { ...sprout("off", [delegate("x")]), enabled: false }];
    expect(skillUsage(rs).get("x")).toEqual(["on", "off"]);
    expect(skillUsage(rs, true).get("x")).toEqual(["off"]);
  });
});

describe("trimSlashes", () => {
  it("drops trailing slashes, keeps root, and stays linear on long slash runs", () => {
    expect(trimSlashes("/w/app//")).toBe("/w/app");
    expect(trimSlashes("///")).toBe("/");
    expect(trimSlashes("/w")).toBe("/w");
    expect(trimSlashes(`a${"/".repeat(100_000)}b`)).toBe(`a${"/".repeat(100_000)}b`);
  });
});
