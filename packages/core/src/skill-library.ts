import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Skill } from "./types.js";
import { formatSkillBody, parseDescription, parseFrontmatter, stripFrontmatter } from "./frontmatter.js";

// Re-exported so node-side consumers (and the barrel) still reach it from here.
export { setFrontmatter, stripFrontmatter, formatSkillBody } from "./frontmatter.js";

export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".md")).sort();
  const skills: Skill[] = [];
  for (const file of files) {
    const body = await readFile(join(dir, file), "utf8");
    const fm = parseFrontmatter(body);
    skills.push({
      name: basename(file, ".md"),
      description: parseDescription(body, fm),
      body,
      enabled: fm.enabled?.toLowerCase() !== "false",
      target: fm.target?.toLowerCase() === "chat" ? "chat" : undefined,
    });
  }
  return skills;
}

// Content fingerprint ignoring the `enabled` flag — so toggling a built-in skill on/off (which
// writes a shadow copy into userDir) isn't mistaken for the user actually customizing it.
function fingerprint(body: string): string {
  const fm = parseFrontmatter(body);
  const fmKeys = Object.keys(fm).filter((k) => k !== "enabled").sort();
  return `${fmKeys.map((k) => `${k}:${fm[k]}`).join("\n")}\n---\n${stripFrontmatter(body).trim()}`;
}

// Merges the repo-shipped built-in skills (projectDir) with the user's ~/.bean/skills
// (userDir): a user file with the same name replaces the project one; anything present in
// only one dir still shows up. Tags each result with which layer is currently in effect. A user
// file that's byte-identical to its built-in counterpart except for the `enabled` flag is NOT a
// real customization (just an enable/disable toggle) — it stays tagged "project" so the UI
// doesn't claim the user authored it.
export async function loadLayeredSkills(projectDir: string, userDir: string): Promise<Skill[]> {
  const [projectSkills, userSkills] = await Promise.all([loadSkills(projectDir), loadSkills(userDir)]);
  const byName = new Map<string, Skill>();
  for (const s of projectSkills) byName.set(s.name, { ...s, source: "project" });
  for (const s of userSkills) {
    const builtin = byName.get(s.name);
    const customized = !builtin || fingerprint(builtin.body) !== fingerprint(s.body);
    byName.set(s.name, { ...s, source: customized ? "user" : "project", overridesBuiltIn: customized && Boolean(builtin) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveSkill(dir: string, name: string, body: string): Promise<void> {
  // ponytail: guard against path traversal across the IPC trust boundary
  if (/[/\\]|\.\./.test(name)) throw new Error(`invalid skill name: ${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), formatSkillBody(body), "utf8");
}

export async function deleteSkill(dir: string, name: string): Promise<void> {
  // ponytail: same traversal guard as saveSkill — the callee, not just the caller, must reject it
  if (/[/\\]|\.\./.test(name)) throw new Error(`invalid skill name: ${name}`);
  await rm(join(dir, `${name}.md`), { force: true });
}
