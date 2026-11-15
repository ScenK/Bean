import { expect, test } from "vitest";
import type { Project, Routine } from "@bean/core";
import { countOf, sproutsByProject, withProjectSkill } from "../src/renderer/components/projects/project-members.js";

const p = (name: string, extra: Partial<Project> = {}): Project => ({ name, path: `/w/${name}`, ...extra });
const r = (name: string, folder?: string, extra: Partial<Routine> = {}): Routine => ({
  name, enabled: true, cron: "0 8 * * *", sinks: {},
  steps: [folder ? { kind: "delegate", instruction: "x", project: folder } : { kind: "chat", instruction: "x" }],
  ...extra,
});

test("sprouts land under the projects the Sprouts window lists them under; Scratch sprouts under none", () => {
  const projects = [p("app"), p("web")];
  const map = sproutsByProject([r("a", "/w/app/sub"), r("b", "/w/app"), r("c"), r("d", "/elsewhere", { projects: ["/w/web", "/w/app"] })], projects);
  expect(Object.fromEntries(map)).toEqual({ "/w/app": ["a", "b", "d"], "/w/web": ["d"] });
});

test("withProjectSkill adds once, removes, drops an emptied list, and leaves other projects alone", () => {
  const projects = [p("app", { skills: ["x"] }), p("web")];
  expect(withProjectSkill(projects, "/w/web", "x", true)).toEqual([p("app", { skills: ["x"] }), p("web", { skills: ["x"] })]);
  expect(withProjectSkill(projects, "/w/app", "x", true)).toEqual(projects);
  expect(withProjectSkill(projects, "/w/app", "x", false)).toEqual([p("app"), p("web")]);
  expect(withProjectSkill(projects, "/w/app", "x", false)[0]).not.toHaveProperty("skills");
});

test("countOf pluralises", () => {
  expect([countOf(0, "skill"), countOf(1, "skill"), countOf(2, "sprout")]).toEqual(["0 skills", "1 skill", "2 sprouts"]);
});
