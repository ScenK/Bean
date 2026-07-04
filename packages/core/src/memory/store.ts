import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isValidMemory, type Memory } from "./memory.js";

export async function loadMemories(file: string): Promise<Memory[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMemory);
  } catch {
    return [];
  }
}

export async function saveMemories(file: string, memories: Memory[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(memories, null, 2) + "\n", "utf8");
}
