import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function notificationPermissionFile(userDataDir: string): string {
  return join(userDataDir, "notification-permission.json");
}

export async function hasRequestedNotificationPermission(file: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { requested?: boolean };
    return parsed.requested === true;
  } catch {
    return false;
  }
}

export async function markNotificationPermissionRequested(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ requested: true }), "utf8");
}
