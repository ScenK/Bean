import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadLayeredSkills, saveSkill, deleteSkill, setFrontmatter } from "../src/skill-library.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("parses frontmatter description", async () => {
  await writeFile(join(dir, "review-code.md"), "---\ndescription: Review a MR\n---\n# Review\nbody");
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("review-code");
  expect(skills[0]!.description).toBe("Review a MR");
  expect(skills[0]!.body).toContain("# Review");
});

test("parses enabled frontmatter; defaults to enabled=true", async () => {
  await writeFile(join(dir, "a.md"), "---\ndescription: d\n---\nbody");
  await writeFile(join(dir, "b.md"), "---\nenabled: false\n---\nbody");
  const [a, b] = await loadSkills(dir);
  expect(a!.enabled).toBe(true);
  expect(b!.enabled).toBe(false);
});

test("parses target frontmatter; only 'chat' is recognized, absent stays undefined", async () => {
  await writeFile(join(dir, "a.md"), "---\ntarget: chat\n---\nbody");
  await writeFile(join(dir, "b.md"), "---\ndescription: d\n---\nbody");
  await writeFile(join(dir, "c.md"), "---\ntarget: terminal\n---\nbody");
  const [a, b, c] = await loadSkills(dir);
  expect(a!.target).toBe("chat");
  expect(b!.target).toBeUndefined();
  expect(c!.target).toBeUndefined();
});

test("setFrontmatter upserts, removes, and creates a block", async () => {
  // upsert into existing block
  expect(setFrontmatter("---\ndescription: d\n---\nbody", "enabled", "false"))
    .toBe("---\ndescription: d\nenabled: false\n---\nbody");
  // remove a key
  expect(setFrontmatter("---\nenabled: false\n---\nbody", "enabled", undefined))
    .toBe("---\n\n---\nbody");
  // create a block when none exists
  expect(setFrontmatter("body", "enabled", "false"))
    .toBe("---\nenabled: false\n---\nbody");
  // removing from a file with no block is a no-op
  expect(setFrontmatter("body", "enabled", undefined)).toBe("body");
});

test("falls back to first heading line for description", async () => {
  await writeFile(join(dir, "investigate.md"), "# Investigate a bug\nsteps...");
  const skills = await loadSkills(dir);
  expect(skills[0]!.description).toBe("Investigate a bug");
});

test("ignores non-md files and returns empty for missing dir", async () => {
  await writeFile(join(dir, "notes.txt"), "nope");
  expect(await loadSkills(join(dir, "nope-dir"))).toEqual([]);
  expect(await loadSkills(dir)).toEqual([]);
});

test("saveSkill writes the file with the given body", async () => {
  await saveSkill(dir, "new-skill", "# New skill\nbody text");
  const skills = await loadSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("new-skill");
  expect(skills[0]!.body).toBe("# New skill\nbody text");
});

test("saveSkill creates the skills directory if missing", async () => {
  const missing = join(dir, "nested");
  await saveSkill(missing, "review-code", "body");
  const skills = await loadSkills(missing);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("review-code");
});

test("saveSkill overwrites existing content", async () => {
  await writeFile(join(dir, "review-code.md"), "old body");
  await saveSkill(dir, "review-code", "new body");
  const raw = await readFile(join(dir, "review-code.md"), "utf8");
  expect(raw).toBe("new body");
});

test("saveSkill rejects a name containing a path separator", async () => {
  await expect(saveSkill(dir, "foo/bar", "x")).rejects.toThrow();
  await expect(saveSkill(dir, "foo\\bar", "x")).rejects.toThrow();
});

test("saveSkill rejects a name containing '..'", async () => {
  await expect(saveSkill(dir, "../../etc/passwd", "x")).rejects.toThrow();
  await expect(saveSkill(dir, "..", "x")).rejects.toThrow();
});

test("deleteSkill removes the skill file", async () => {
  await saveSkill(dir, "review-code", "body");
  await deleteSkill(dir, "review-code");
  expect(await loadSkills(dir)).toEqual([]);
});

test("deleteSkill is a no-op when the file doesn't exist", async () => {
  await expect(deleteSkill(dir, "nonexistent")).resolves.toBeUndefined();
});

test("deleteSkill rejects a name containing a path separator or '..'", async () => {
  await expect(deleteSkill(dir, "foo/bar")).rejects.toThrow();
  await expect(deleteSkill(dir, "foo\\bar")).rejects.toThrow();
  await expect(deleteSkill(dir, "../../etc/passwd")).rejects.toThrow();
});

let projectDir: string;
let userDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "bean-skills-project-"));
  userDir = await mkdtemp(join(tmpdir(), "bean-skills-user-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

test("loadLayeredSkills: user overrides project by name", async () => {
  await writeFile(join(projectDir, "a.md"), "OLD");
  await writeFile(join(userDir, "a.md"), "NEW");
  const skills = await loadLayeredSkills(projectDir, userDir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.body).toBe("NEW");
  expect(skills[0]!.source).toBe("user");
});

test("loadLayeredSkills: non-colliding names from both dirs are unioned", async () => {
  await writeFile(join(projectDir, "a.md"), "project body");
  await writeFile(join(userDir, "b.md"), "user body");
  const skills = await loadLayeredSkills(projectDir, userDir);
  expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
  expect(skills[0]!.source).toBe("project");
  expect(skills[1]!.source).toBe("user");
});

test("loadLayeredSkills: missing project dir behaves like today (user skills only)", async () => {
  await writeFile(join(userDir, "b.md"), "user body");
  const skills = await loadLayeredSkills(join(projectDir, "nope"), userDir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("b");
  expect(skills[0]!.source).toBe("user");
});
