import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Which core the shell runs against, in Electron userData (#810): `"local"` = the in-process core on
 * this machine, `null` = none attached (boot shows Add a core). #811 adds remote entries and their ids. */
export interface CoreChoice { selected: "local" | null }

export function coreFile(userDataDir: string): string {
  return join(userDataDir, "cores.json");
}

/** No file (first run) or an unreadable one: a Mac runs its local core, as before; elsewhere none. An id
 * this version doesn't know (a remote core, written by a newer shell) is not the local core. */
export async function loadCoreChoice(file: string, platform: NodeJS.Platform): Promise<CoreChoice> {
  try {
    const { selected } = JSON.parse(await readFile(file, "utf8")) as { selected?: unknown };
    if (selected !== undefined) return { selected: selected === "local" ? "local" : null };
  } catch { /* first run or corrupt: the default */ }
  return { selected: platform === "darwin" ? "local" : null };
}

export async function saveCoreChoice(file: string, choice: CoreChoice): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(choice), "utf8");
}
