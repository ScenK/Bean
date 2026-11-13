import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatopsBot } from "./chatops-servers.js";

const BOTS: ChatopsBot[] = ["discord", "teams"];

/** The bots the user last had switched on — restarted on the next boot so a quit, a dev
 * relaunch, or an update install doesn't silently leave the chat bots off. */
export async function loadChatopsEnabled(file: string): Promise<ChatopsBot[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { enabled?: unknown };
    const enabled = Array.isArray(parsed.enabled) ? parsed.enabled : [];
    return BOTS.filter((bot) => enabled.includes(bot));
  } catch {
    return [];
  }
}

export async function saveChatopsEnabled(file: string, enabled: ChatopsBot[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // Write-then-rename, because writeFile truncates first: a force quit, crash, or update exit
  // landing mid-write leaves a partial file, and loadChatopsEnabled() reads anything unparseable
  // as "nothing enabled" — silently switching every bot off. rename(2) within one directory is
  // atomic, so a reader sees either the old contents or the new ones, never a torn file.
  // A fixed temp name is safe here: the host chains these writes, so there is only ever one writer.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ enabled }), "utf8");
  await rename(tmp, file);
}

/** Before #805 the set lived in Electron's userData, where a host without the app can't see it.
 * Copies it into the data directory once: the new file existing at all (even an empty set) means
 * migrated, so the legacy file is never read again. It is left in place for a downgrade. */
export async function migrateChatopsEnabled(file: string, legacyFile: string): Promise<void> {
  if (existsSync(file) || !existsSync(legacyFile)) return;
  await saveChatopsEnabled(file, await loadChatopsEnabled(legacyFile));
}
