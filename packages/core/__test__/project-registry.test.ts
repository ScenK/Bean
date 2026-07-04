import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjects, saveProjects } from "../src/project-registry.js";
import type { Project } from "../src/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-proj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns empty list", async () => {
  expect(await loadProjects(join(dir, "projects.json"))).toEqual([]);
});

test("save then load round-trips", async () => {
  const file = join(dir, "nested", "projects.json");
  const projects: Project[] = [{ name: "acme", path: "/x/acme", defaultSkill: "review-code" }];
  await saveProjects(file, projects);
  expect(await loadProjects(file)).toEqual(projects);
});
