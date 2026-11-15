import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { foldDefaultSkills, loadProjects, saveProjects, type LegacyProject } from "../src/project-registry.js";
import { bestProjectForSkill } from "../src/project-select.js";
import type { Project } from "../src/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-proj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns empty list", async () => {
  expect(await loadProjects(join(dir, "projects.json"))).toEqual([]);
});

test("save then load round-trips", async () => {
  const file = join(dir, "nested", "projects.json");
  const projects: Project[] = [{ name: "acme", path: "/x/acme", skills: ["review-code"] }];
  await saveProjects(file, projects);
  expect(await loadProjects(file)).toEqual(projects);
});

// The old resolution order: every `skills` list first, then the first `defaultSkill`.
const legacyBest = (skill: string, ps: LegacyProject[]): string | undefined =>
  (ps.find((p) => p.skills?.includes(skill)) ?? ps.find((p) => p.defaultSkill === skill))?.path;

test("folding defaultSkill keeps every skill resolving to the same project", () => {
  const registries: LegacyProject[][] = [
    [{ name: "a", path: "/a", defaultSkill: "x" }, { name: "b", path: "/b", skills: ["x"] }], // B
    [{ name: "a", path: "/a", defaultSkill: "x" }, { name: "b", path: "/b", defaultSkill: "x" }], // the first
    [{ name: "a", path: "/a", defaultSkill: "x", skills: ["y"] }, { name: "b", path: "/b", defaultSkill: "y" }],
  ];
  for (const ps of registries) {
    const folded = foldDefaultSkills(ps);
    for (const skill of ["x", "y", "z"]) expect(bestProjectForSkill(skill, folded)?.path).toBe(legacyBest(skill, ps));
    expect(folded.some((p) => "defaultSkill" in p)).toBe(false);
    expect(foldDefaultSkills(folded)).toEqual(folded); // idempotent
  }
  expect(foldDefaultSkills(registries[0]!)).toEqual([{ name: "a", path: "/a" }, { name: "b", path: "/b", skills: ["x"] }]);
  expect(foldDefaultSkills(registries[1]!)).toEqual([{ name: "a", path: "/a", skills: ["x"] }, { name: "b", path: "/b" }]);
});

test("load folds a legacy defaultSkill without rewriting the file", async () => {
  const file = join(dir, "projects.json");
  const raw = JSON.stringify([{ name: "a", path: "/a", defaultSkill: "x" }]);
  await writeFile(file, raw);
  expect(await loadProjects(file)).toEqual([{ name: "a", path: "/a", skills: ["x"] }]);
  expect(await readFile(file, "utf8")).toBe(raw);
});
