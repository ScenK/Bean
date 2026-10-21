import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OutboxMessage } from "./outbox.js";

/** Where a chatops reminder goes: Discord — the setter's DM (`userId`) or the channel it was
 * set in; Teams — always the conversation it was set in (1:1, group chat or channel thread),
 * since Teams' outbox ignores `userId`. Stamped from the authenticated ingress, never from
 * model arguments. */
export type ReminderTarget =
  | { transport: "discord"; userId: string }
  | { transport: "discord"; channelId: string }
  | { transport: "teams"; channelId: string };

export interface Reminder {
  id: string;
  text: string;
  at: string; // ISO 8601 timestamp
  firedAt?: string;
  /** Absent = a desktop reminder (fires as a notification). */
  target?: ReminderTarget;
  /** Platform id of whoever set it (chatops only) — members list and cancel only their own. */
  setBy?: string;
}

// `target` isn't checked here at all: a malformed one (even null or a string) must survive
// load/save and fail loudly at delivery (reminderOutbox), not vanish silently on the next write.
export function isValidReminder(value: unknown): value is Reminder {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.text === "string" &&
    typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) &&
    (r.firedAt === undefined || typeof r.firedAt === "string") &&
    (r.setBy === undefined || typeof r.setBy === "string");
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
  // tmp + rename: a reader in another process never sees a half-written file. The temp name
  // is per-process so two writers can't interleave into one tmp.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(reminders, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export function dueReminders(reminders: Reminder[], now: Date): Reminder[] {
  return reminders.filter((r) => !r.firedAt && Date.parse(r.at) <= now.getTime());
}

const chains = new Map<string, Promise<unknown>>();
const LOCK_STALE_MS = 10_000;

// Cross-process: the desktop app's delivery loop and the Discord bot it spawns both write this
// file. O_EXCL lock file; one left by a crashed process is broken after LOCK_STALE_MS.
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rm(lock, { force: true });
      else await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** The only way to change reminders.json: load, `fn` mutates the list in place, save — one
 * in-process promise chain per file plus a lock file across processes, so a tool call and the
 * delivery loop can't overwrite each other (a lost reminder, or a re-fired one). */
export function updateReminders<T>(file: string, fn: (reminders: Reminder[]) => T): Promise<T> {
  const run = (chains.get(file) ?? Promise.resolve()).catch(() => {}).then(() => withFileLock(file, async () => {
    const reminders = await loadReminders(file);
    const out = fn(reminders);
    await saveReminders(file, reminders);
    return out;
  }));
  chains.set(file, run);
  return run;
}

/** Marks every due reminder fired and returns them, in one update: the mark is saved before
 * anything is delivered, so a crash mid-delivery skips a reminder rather than firing it twice. */
export function claimDueReminders(file: string, now: Date): Promise<Reminder[]> {
  return updateReminders(file, (reminders) => {
    const due = dueReminders(reminders, now);
    for (const r of due) r.firedAt = now.toISOString();
    return due;
  });
}

/** Removes a pending reminder. `setBy` set = only that person's reminder may go (non-owners);
 * absent = any (the owner). Idempotent: an unknown or already-fired id is "missing". */
export function cancelReminder(file: string, id: string, setBy?: string): Promise<{ outcome: "cancelled" | "missing" | "forbidden"; text?: string; target?: ReminderTarget }> {
  return updateReminders(file, (reminders) => {
    const i = reminders.findIndex((r) => r.id === id && !r.firedAt);
    const r = reminders[i];
    if (!r) return { outcome: "missing" as const };
    if (setBy !== undefined && r.setBy !== setBy) return { outcome: "forbidden" as const };
    reminders.splice(i, 1);
    return { outcome: "cancelled" as const, text: r.text, ...(r.target === undefined ? {} : { target: r.target }) };
  });
}

/** The outbox message for a targeted reminder. Throws on a malformed target — never falls
 * back to the owner's DM. */
export function reminderOutbox(r: Reminder): Omit<OutboxMessage, "id" | "createdAt"> {
  const t = r.target as Record<string, unknown> | undefined;
  const transport = t?.transport;
  if (transport === "teams") {
    if (typeof t?.channelId === "string" && t.channelId && t.userId === undefined) {
      return { transport, channel: t.channelId, title: "⏰ Reminder", body: r.text };
    }
    throw new Error(`reminder ${r.id}: a Teams target needs a channelId and no userId`);
  }
  if (transport !== "discord") throw new Error(`reminder ${r.id}: bad target transport`);
  const base = { transport, title: "⏰ Reminder", body: r.text } as const;
  if (typeof t?.userId === "string" && t.userId && t.channelId === undefined) return { ...base, userId: t.userId };
  if (typeof t?.channelId === "string" && t.channelId && t.userId === undefined) return { ...base, channel: t.channelId };
  throw new Error(`reminder ${r.id}: target needs exactly one of userId / channelId`);
}

export interface ReminderDelivery {
  /** A reminder without a target (desktop: a notification; headless: the owner's DM). */
  untargeted: (r: Reminder) => Promise<unknown> | void;
  enqueue: (msg: Omit<OutboxMessage, "id" | "createdAt">) => Promise<unknown>;
  /** Loud failure: a malformed target or a failed hand-off. The reminder stays fired. */
  failed: (r: Reminder, err: unknown) => void;
}

/** One delivery-loop tick, shared by the desktop app and the headless Discord host. */
export async function fireDueReminders(file: string, now: Date, d: ReminderDelivery): Promise<void> {
  for (const r of await claimDueReminders(file, now)) {
    try {
      if (r.target === undefined) await d.untargeted(r);
      else await d.enqueue(reminderOutbox(r));
    } catch (err) {
      d.failed(r, err);
    }
  }
}
