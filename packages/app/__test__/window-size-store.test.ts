import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampWindowSize, loadWindowSize, saveWindowSize, windowSizeFile } from "../src/window-size-store.js";

const work = { width: 1440, height: 900 };
const fallback = { width: 820, height: 760 };
const min = { width: 440, height: 520 };

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bean-window-size-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("missing file falls back to the default size", () => withDir((dir) => {
  expect(loadWindowSize(windowSizeFile(dir, "chat"), fallback, min, work)).toEqual(fallback);
}));

test("corrupt JSON falls back to the default size", () => withDir(async (dir) => {
  const file = windowSizeFile(dir, "chat");
  await writeFile(file, "{not json", "utf8");
  expect(loadWindowSize(file, fallback, min, work)).toEqual(fallback);
}));

test("each kind remembers its own size; chat keeps its old file name", () => withDir((dir) => {
  expect(windowSizeFile(dir, "chat")).toBe(join(dir, "chat-size.json"));
  saveWindowSize(windowSizeFile(dir, "chat"), { width: 700, height: 820 });
  saveWindowSize(windowSizeFile(dir, "routines"), { width: 1000, height: 600 });
  expect(loadWindowSize(windowSizeFile(dir, "chat"), fallback, min, work)).toEqual({ width: 700, height: 820 });
  expect(loadWindowSize(windowSizeFile(dir, "routines"), fallback, min, work)).toEqual({ width: 1000, height: 600 });
  expect(loadWindowSize(windowSizeFile(dir, "notes"), fallback, min, work)).toEqual(fallback);
}));

test("non-finite or non-numeric values fall back to the default", () => {
  expect(clampWindowSize({ width: Infinity, height: 800 }, fallback, min, work)).toEqual(fallback);
  expect(clampWindowSize({ width: 700, height: NaN }, fallback, min, work)).toEqual(fallback);
  expect(clampWindowSize({ width: "700", height: 800 }, fallback, min, work)).toEqual(fallback);
  expect(clampWindowSize(null, fallback, min, work)).toEqual(fallback);
});

test("too small is raised to the minimum", () => {
  expect(clampWindowSize({ width: 100, height: 200 }, fallback, min, work)).toEqual(min);
});

test("larger than the work area is cut to the work area", () => {
  expect(clampWindowSize({ width: 5000, height: 4000 }, fallback, min, work)).toEqual(work);
  // The default is clamped too, on a display smaller than it.
  expect(clampWindowSize(undefined, fallback, min, { width: 1280, height: 700 })).toEqual({ width: 820, height: 700 });
});
