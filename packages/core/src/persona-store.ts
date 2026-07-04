import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PERSONA, isValidPersona, type Persona } from "./persona.js";

async function tryReadPersona(file: string): Promise<Persona | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return isValidPersona(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPersona(file: string, fallbackFile?: string): Promise<Persona> {
  return (
    (await tryReadPersona(file)) ??
    (fallbackFile ? await tryReadPersona(fallbackFile) : undefined) ??
    DEFAULT_PERSONA
  );
}

export async function savePersona(file: string, persona: Persona): Promise<void> {
  if (!isValidPersona(persona)) throw new Error("invalid persona: name and at least one tag are required");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(persona, null, 2) + "\n", "utf8");
}
