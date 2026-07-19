import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAMES } from "./launcher.js";
import type { CliName } from "./launcher.js";
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
export function clisFile(dir: string): string { return join(dir, "clis.json"); }
export function personaFile(dir: string): string { return join(dir, "persona.json"); }
export function memoryFile(dir: string): string { return join(dir, "memory.json"); }
// SQLite store for memories/notes/chatops history (replaces memory.json + notes/*.md as of
// the FTS5 migration — see .memory/project-bean-memory.md). One shared file: SQLite's own
// WAL locking is the cross-process write serialization the old flat-file stores never had.
export function dbFile(dir: string): string { return join(dir, "bean.db"); }
export function remindersFile(dir: string): string { return join(dir, "reminders.json"); }
export function notesDir(dir: string): string { return join(dir, "notes"); }
export function routinesDir(dir: string): string { return join(dir, "routines"); }
export function routineStateFile(dir: string): string { return join(dir, "routines", ".state.json"); }
export function outboxDir(dir: string): string { return join(dir, "outbox"); }
export function runsDir(dir: string): string { return join(dir, "runs"); }
export function modelMemoryFile(dir: string): string { return join(dir, "model-memory.json"); }
// A "no project" run's working directory (2a) — the launched CLI's cwd when no real project
// was picked. Bean never seeds it (no git clone/page fetch): if the user typed an optional
// URL, it's folded into the composed prompt instead, and the launched agent (opencode/claude/codex,
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
    systemControls: parsed.systemControls ?? false,
    liveSessions: parsed.liveSessions ?? false,
    disabledClis: Array.isArray(parsed.disabledClis)
      ? parsed.disabledClis.filter((c): c is CliName => (CLI_NAMES as readonly string[]).includes(c as string))
      : [],
    beanDir: beanDirPath,
  };
}

export async function saveConfig(
  file: string,
  config: { openaiApiKey: string; model: string; terminalApp?: string; editorApp?: string; delegateCli?: string; systemControls?: boolean; liveSessions?: boolean; disabledClis?: string[] },
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // No Settings UI toggle exists for liveSessions, so a desktop Settings save calls this with
  // that field omitted entirely. Preserve either optional field when a caller does not know
  // about it; only a brand-new file falls back to defaults. (Current Settings does send
  // disabledClis, while older callers and first-launch bootstrap may omit it.)
  let existing: Partial<BeanConfig> = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as Partial<BeanConfig>;
  } catch {
    // No existing file yet, or it's invalid — nothing to preserve.
  }
  const out = {
    openaiApiKey: config.openaiApiKey, model: config.model,
    terminalApp: config.terminalApp ?? "", editorApp: config.editorApp ?? "", delegateCli: config.delegateCli ?? "",
    systemControls: config.systemControls ?? false,
    liveSessions: config.liveSessions ?? existing.liveSessions ?? false,
    disabledClis: config.disabledClis ?? existing.disabledClis ?? [],
  };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
}
