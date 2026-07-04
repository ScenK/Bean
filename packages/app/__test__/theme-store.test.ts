import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THEME, loadTheme, saveTheme, themeFile } from "../src/theme-store.js";

test("loadTheme returns the default when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const theme = await loadTheme(themeFile(dir));
    expect(theme).toBe(DEFAULT_THEME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveTheme then loadTheme round-trips a non-default theme", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const file = themeFile(dir);
    await saveTheme(file, "graphite");
    const theme = await loadTheme(file);
    expect(theme).toBe("graphite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTheme falls back to the default on invalid file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-theme-"));
  try {
    const file = themeFile(dir);
    await saveTheme(file, "graphite");
    await writeFile(file, "not json", "utf8");
    const theme = await loadTheme(file);
    expect(theme).toBe(DEFAULT_THEME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
