import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Theme } from "./channels.js";

export const DEFAULT_THEME: Theme = "hearth";

export function themeFile(userDataDir: string): string {
  return join(userDataDir, "theme.json");
}

export async function loadTheme(file: string): Promise<Theme> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { theme?: string };
    return parsed.theme === "graphite" ? "graphite" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export async function saveTheme(file: string, theme: Theme): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ theme }), "utf8");
}
