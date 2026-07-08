import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** skillName -> last-used canonical model id, backing the "LAST USED · <skill>" badge. */
export type ModelMemory = Record<string, string>;

export async function loadModelMemory(file: string): Promise<ModelMemory> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ModelMemory = {};
    for (const [skill, modelId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof modelId === "string") out[skill] = modelId;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveModelMemory(file: string, memory: ModelMemory): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(memory, null, 2) + "\n", "utf8");
}
