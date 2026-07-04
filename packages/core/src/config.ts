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
    beanDir: beanDirPath,
  };
}

export async function saveConfig(
  file: string,
  config: { openaiApiKey: string; model: string; terminalApp: string; editorApp?: string },
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const out = {
    openaiApiKey: config.openaiApiKey, model: config.model,
    terminalApp: config.terminalApp, editorApp: config.editorApp ?? "",
  };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}
