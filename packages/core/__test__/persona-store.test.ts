import { expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona, savePersona } from "../src/persona-store.js";
import { DEFAULT_PERSONA, type Persona, type PersonaTag } from "../src/persona.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-persona-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("missing file returns the default persona", async () => {
  expect(await loadPersona(join(dir, "persona.json"))).toEqual(DEFAULT_PERSONA);
});

test("invalid JSON returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, "{ not json");
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an empty name fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "  ", tags: ["Warm"] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an empty tags array fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "Bean", tags: [] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("an unknown tag value fails validation and returns the default persona", async () => {
  const file = join(dir, "persona.json");
  await writeFile(file, JSON.stringify({ name: "Bean", tags: ["Sarcastic"] }));
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("save then load round-trips", async () => {
  const file = join(dir, "nested", "persona.json");
  const persona: Persona = { name: "Buddy", tags: ["Playful", "Warm"] };
  await savePersona(file, persona);
  expect(await loadPersona(file)).toEqual(persona);
});

test("savePersona creates the parent directory if missing", async () => {
  const file = join(dir, "nested", "persona.json");
  await savePersona(file, DEFAULT_PERSONA);
  expect(await loadPersona(file)).toEqual(DEFAULT_PERSONA);
});

test("savePersona rejects an empty/whitespace-only name", async () => {
  await expect(savePersona(join(dir, "persona.json"), { name: "   ", tags: ["Warm"] })).rejects.toThrow();
});

test("savePersona rejects an empty tags array", async () => {
  await expect(savePersona(join(dir, "persona.json"), { name: "Bean", tags: [] })).rejects.toThrow();
});

test("savePersona rejects a tag not in PERSONA_TAGS", async () => {
  const bad = { name: "Bean", tags: ["Sarcastic" as PersonaTag] };
  await expect(savePersona(join(dir, "persona.json"), bad)).rejects.toThrow();
});

test("falls back to the project persona file when the user file is missing", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const projectPersona: Persona = { name: "Builtin", tags: ["Formal"] };
  await writeFile(projectFile, JSON.stringify(projectPersona));
  expect(await loadPersona(userFile, projectFile)).toEqual(projectPersona);
});

test("user file wins over the project file when both exist", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const userPersona: Persona = { name: "Mine", tags: ["Playful"] };
  await writeFile(userFile, JSON.stringify(userPersona));
  await writeFile(projectFile, JSON.stringify({ name: "Builtin", tags: ["Formal"] }));
  expect(await loadPersona(userFile, projectFile)).toEqual(userPersona);
});

test("invalid user JSON falls back to the project file", async () => {
  const userFile = join(dir, "persona.json");
  const projectFile = join(dir, "project-persona.json");
  const projectPersona: Persona = { name: "Builtin", tags: ["Formal"] };
  await writeFile(userFile, "{ not json");
  await writeFile(projectFile, JSON.stringify(projectPersona));
  expect(await loadPersona(userFile, projectFile)).toEqual(projectPersona);
});

test("falls back to DEFAULT_PERSONA when neither file exists", async () => {
  expect(await loadPersona(join(dir, "nope.json"), join(dir, "also-nope.json"))).toEqual(DEFAULT_PERSONA);
});
