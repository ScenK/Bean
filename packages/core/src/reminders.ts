import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Reminder {
  id: string;
  text: string;
  at: string; // ISO 8601 timestamp
  firedAt?: string;
}

export function isValidReminder(value: unknown): value is Reminder {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.text === "string" &&
    typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) &&
    (r.firedAt === undefined || typeof r.firedAt === "string");
}

export async function loadReminders(file: string): Promise<Reminder[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidReminder);
  } catch {
    return [];
  }
}

export async function saveReminders(file: string, reminders: Reminder[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(reminders, null, 2) + "\n", "utf8");
}

export function dueReminders(reminders: Reminder[], now: Date): Reminder[] {
  return reminders.filter((r) => !r.firedAt && Date.parse(r.at) <= now.getTime());
}
