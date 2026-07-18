import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, skillsDir, projectsFile, configFile, personaFile, projectBeanDir } from "../src/config.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-cfg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("path helpers", () => {
  expect(skillsDir("/b")).toBe("/b/skills");
  expect(projectsFile("/b")).toBe("/b/projects.json");
  expect(configFile("/b")).toBe("/b/config.json");
  expect(personaFile("/b")).toBe("/b/persona.json");
});

test("loads config and defaults model", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.openaiApiKey).toBe("sk-x");
  expect(cfg.model).toBe("gpt-4o-mini");
  expect(cfg.beanDir).toBe("/b");
});

test("throws when missing", async () => {
  await expect(loadConfig(join(dir, "nope.json"), "/b")).rejects.toThrow("Bean config missing");
});

test("throws when malformed json", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, "{ not json");
  await expect(loadConfig(file, "/b")).rejects.toThrow(/Bean config invalid/);
});

test("saveConfig round-trips openaiApiKey and model", async () => {
  const file = join(dir, "sub", "config.json"); // nested to prove mkdir -p
  await saveConfig(file, { openaiApiKey: "sk-new", model: "gpt-5" });
  const cfg = await loadConfig(file, "/b");
  expect(cfg.openaiApiKey).toBe("sk-new");
  expect(cfg.model).toBe("gpt-5");
});

test("saveConfig writes only persisted config fields (no beanDir)", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "" });
  const parsed = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(parsed).sort()).toEqual(["delegateCli", "editorApp", "liveSessions", "model", "openaiApiKey", "systemControls", "terminalApp"]);
});

test("loads config and defaults terminalApp to empty string", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("");
});

test("loadConfig preserves a configured terminalApp", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x", terminalApp: "/Applications/iTerm.app" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("/Applications/iTerm.app");
});

test("saveConfig round-trips terminalApp", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "/Applications/Warp.app" });
  const cfg = await loadConfig(file, "/b");
  expect(cfg.terminalApp).toBe("/Applications/Warp.app");
});

test("loads config and defaults editorApp to empty string", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.editorApp).toBe("");
});

test("saveConfig round-trips editorApp", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "", editorApp: "/Applications/Zed.app" });
  const cfg = await loadConfig(file, "/b");
  expect(cfg.editorApp).toBe("/Applications/Zed.app");
});

test("defaults delegateCli to empty and round-trips it through save", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "sk-x" }));
  const cfg = await loadConfig(file, "/b");
  expect(cfg.delegateCli).toBe("");

  await saveConfig(file, { openaiApiKey: "sk-x", model: "m", terminalApp: "", editorApp: "", delegateCli: "claude" });
  const roundTripped = await loadConfig(file, "/b");
  expect(roundTripped.delegateCli).toBe("claude");
});

test("projectBeanDir resolves to <repo-root>/.bean", () => {
  // This test file lives at packages/core/__test__/config.test.ts, a sibling of src/ and dist/
  // under packages/core — three directories up from any of the three reaches the repo root.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  expect(projectBeanDir()).toBe(join(repoRoot, ".bean"));
});

test("defaults liveSessions to false and round-trips it through saveConfig", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "k", model: "m" }), "utf8");
  const cfg = await loadConfig(file, dir);
  expect(cfg.liveSessions).toBe(false);

  await saveConfig(file, { openaiApiKey: "k", model: "m", liveSessions: true });
  const cfg2 = await loadConfig(file, dir);
  expect(cfg2.liveSessions).toBe(true);
});

test("saveConfig preserves an existing liveSessions value when the caller omits it (e.g. a Settings save)", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "k", model: "m", liveSessions: true });
  // A caller that doesn't know about liveSessions (the desktop Settings save has no toggle
  // for it) must not silently flip it back off when it re-saves the fields it does know about.
  await saveConfig(file, { openaiApiKey: "k", model: "m2" });
  const cfg = await loadConfig(file, dir);
  expect(cfg.liveSessions).toBe(true);
});

test("saveConfig defaults liveSessions to false on a brand-new file when the caller omits it", async () => {
  const file = join(dir, "config.json");
  await saveConfig(file, { openaiApiKey: "k", model: "m" });
  const cfg = await loadConfig(file, dir);
  expect(cfg.liveSessions).toBe(false);
});
