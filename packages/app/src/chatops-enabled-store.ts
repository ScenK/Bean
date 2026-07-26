import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatopsBot } from "./chatops-servers.js";

const BOTS: ChatopsBot[] = ["discord", "teams"];

export function chatopsEnabledFile(userDataDir: string): string {
  return join(userDataDir, "chatops-enabled.json");
}

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
  await writeFile(file, JSON.stringify({ enabled }), "utf8");
}
