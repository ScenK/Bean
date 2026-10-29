import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_DEFAULT_SIZE, CHAT_MIN_SIZE, chatSizeFile, clampChatSize, loadChatSize, saveChatSize,
} from "../src/chat-size-store.js";

const work = { width: 1440, height: 900 };

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bean-chat-size-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("missing file falls back to the default size", () => withDir((dir) => {
  expect(loadChatSize(chatSizeFile(dir), work)).toEqual(CHAT_DEFAULT_SIZE);
}));

test("corrupt JSON falls back to the default size", () => withDir(async (dir) => {
  const file = chatSizeFile(dir);
  await writeFile(file, "{not json", "utf8");
  expect(loadChatSize(file, work)).toEqual(CHAT_DEFAULT_SIZE);
}));

test("save then load round-trips a remembered size", () => withDir((dir) => {
  const file = chatSizeFile(dir);
  saveChatSize(file, { width: 700, height: 820 });
  expect(loadChatSize(file, work)).toEqual({ width: 700, height: 820 });
}));

test("non-finite or non-numeric values fall back to the default", () => {
  expect(clampChatSize({ width: Infinity, height: 800 }, work)).toEqual(CHAT_DEFAULT_SIZE);
  expect(clampChatSize({ width: 700, height: NaN }, work)).toEqual(CHAT_DEFAULT_SIZE);
  expect(clampChatSize({ width: "700", height: 800 }, work)).toEqual(CHAT_DEFAULT_SIZE);
  expect(clampChatSize(null, work)).toEqual(CHAT_DEFAULT_SIZE);
});

test("too small is raised to the minimum", () => {
  expect(clampChatSize({ width: 100, height: 200 }, work)).toEqual(CHAT_MIN_SIZE);
});

test("larger than the work area is cut to the work area", () => {
  expect(clampChatSize({ width: 5000, height: 4000 }, work)).toEqual(work);
  // The default is clamped too, on a display smaller than it.
  expect(clampChatSize(undefined, { width: 1280, height: 700 })).toEqual({ width: 600, height: 700 });
});
