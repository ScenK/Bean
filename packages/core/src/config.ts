import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BeanConfig } from "./types.js";

export function beanDir(): string {
  return join(homedir(), ".bean");
}
// The repo-shipped counterpart to beanDir(): built-in skills/persona that ~/.bean extends.
// This file compiles flat to packages/core/{src,dist}/config.{ts,js} (rootDir: src, outDir:
// dist, no subfolders), so three directories up from here reaches the repo root identically
// whether running from source (vitest) or the built dist/ output.
export function projectBeanDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", ".bean");
}
export function skillsDir(dir: string): string { return join(dir, "skills"); }
export function projectsFile(dir: string): string { return join(dir, "projects.json"); }
export function configFile(dir: string): string { return join(dir, "config.json"); }
export function personaFile(dir: string): string { return join(dir, "persona.json"); }
export function memoryFile(dir: string): string { return join(dir, "memory.json"); }
export function remindersFile(dir: string): string { return join(dir, "reminders.json"); }
export function notesDir(dir: string): string { return join(dir, "notes"); }
export function routinesDir(dir: string): string { return join(dir, "routines"); }
export function routineStateFile(dir: string): string { return join(dir, "routines", ".state.json"); }
export function outboxDir(dir: string): string { return join(dir, "outbox"); }
export function runsDir(dir: string): string { return join(dir, "runs"); }
export function modelMemoryFile(dir: string): string { return join(dir, "model-memory.json"); }
// A "no project" run's working directory (2a) — the launched CLI's cwd when no real project
// was picked. Bean never seeds it (no git clone/page fetch): if the user typed an optional
// URL, it's folded into the composed prompt instead, and the launched agent (opencode/claude,
// a full coding agent with its own shell/git access) fetches or clones it itself if needed.
export function scratchDir(dir: string): string { return join(dir, "workspace"); }

export async function loadConfig(file: string, beanDirPath: string): Promise<BeanConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Bean config missing: ${file}`);
  }
  let parsed: Partial<BeanConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<BeanConfig>;
  } catch {
    throw new Error(`Bean config invalid: ${file}`);
  }
  return {
    openaiApiKey: parsed.openaiApiKey ?? "",
    model: parsed.model ?? "gpt-4o-mini",
    terminalApp: parsed.terminalApp ?? "",
    editorApp: parsed.editorApp ?? "",
    delegateCli: parsed.delegateCli ?? "",
    beanDir: beanDirPath,
  };
}

export async function saveConfig(
  file: string,
  config: { openaiApiKey: string; model: string; terminalApp?: string; editorApp?: string; delegateCli?: string },
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const out = {
    openaiApiKey: config.openaiApiKey, model: config.model,
    terminalApp: config.terminalApp ?? "", editorApp: config.editorApp ?? "", delegateCli: config.delegateCli ?? "",
  };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}
