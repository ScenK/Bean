import { expect, test } from "vitest";
import type { Project, Skill } from "@bean/core";
import { hasUsage, skillChips, skillGroups } from "../src/renderer/components/skills/SkillsPanel.js";

const sk = (name: string, extra: Partial<Skill> = {}): Skill => ({ name, description: "d", body: "B", ...extra });
const p = (name: string, skills: string[] = []): Project => ({ name, path: `/p/${name}`, skills });
const keys = (skills: Skill[], projects: Project[]) =>
  skillGroups(skills, projects, hasUsage(skills)).map((g) => [g.key, g.skills.map((s) => s.name)]);

test("a sprout-only skill off the avatar and in no project is under Sprout steps; quick-launch or a project moves it to Skills", () => {
  const only = sk("nightly-step", { usedBy: ["nightly"], quickLaunch: false });
  expect(keys([only], [])).toEqual([["sprout-steps", ["nightly-step"]]]);
  expect(keys([{ ...only, quickLaunch: undefined }], [])).toEqual([["skills", ["nightly-step"]]]);
  expect(keys([only], [p("app", ["nightly-step"])])).toEqual([["skills", ["nightly-step"]]]);
});

test("a skill with no avatar, project or sprout is in Skills with a chat & bots chip", () => {
  const plain = sk("ask", { usedBy: [], quickLaunch: false });
  expect(keys([plain], [])).toEqual([["skills", ["ask"]]]);
  expect(skillChips(plain, [])).toEqual([{ label: "chat & bots", kind: "general" }]);
});

test("chips name the avatar, projects and each sprout", () => {
  expect(skillChips(sk("x", { usedBy: ["a", "b"] }), [p("app", ["x"]), p("web")]).map((c) => c.label))
    .toEqual(["avatar", "app", "↻ a", "↻ b"]);
});

test("a disabled skill an enabled sprout still uses warns that the step fails", () => {
  const off = sk("x", { enabled: false, usedBy: ["nightly"], usedByOff: [] });
  expect(keys([off], [])).toEqual([["disabled", ["x"]]]);
  expect(skillChips(off, [])).toEqual([{ label: "used by nightly — its step fails", kind: "warn" }]);
  expect(skillChips(sk("y", { enabled: false, usedBy: [] }), [])).toEqual([]);
});

test("a disabled skill used only by off sprouts gets neutral chips, no warning (#1035)", () => {
  expect(skillChips(sk("x", { enabled: false, usedBy: ["a", "b"], usedByOff: ["a", "b"] }), [])).toEqual([
    { label: "↻ a (off) — fails if run", kind: "general" },
    { label: "↻ b (off) — fails if run", kind: "general" },
  ]);
});

test("a disabled skill used by on and off sprouts warns naming only the on one, plus a neutral chip for the off one", () => {
  expect(skillChips(sk("x", { enabled: false, usedBy: ["live", "paused"], usedByOff: ["paused"] }), [])).toEqual([
    { label: "used by live — its step fails", kind: "warn" },
    { label: "↻ paused (off) — fails if run", kind: "general" },
  ]);
});

test("usedBy absent on any skill renders the flat list (enabled, then Disabled), never Sprout steps", () => {
  const skills = [sk("a", { quickLaunch: false }), sk("b", { enabled: false }), sk("c", { usedBy: ["n"], quickLaunch: false })];
  expect(hasUsage(skills)).toBe(false);
  expect(keys(skills, [])).toEqual([["skills", ["a", "c"]], ["disabled", ["b"]]]);
});

test("empty sections are dropped", () => {
  expect(keys([sk("a", { usedBy: [] })], [])).toEqual([["skills", ["a"]]]);
  expect(keys([], [])).toEqual([]);
});
