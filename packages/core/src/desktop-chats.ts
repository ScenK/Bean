import { openDb } from "./db.js";

/** A desktop chat thread as listed in the history picker — no transcript. */
export interface DesktopChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface DesktopChat extends DesktopChatSummary {
  createdAt: string;
  /** The renderer's transcript items, opaque to core. */
  itemsJson: string;
  noteSlug: string | null;
}

export interface DesktopChatInput {
  id: string;
  title: string;
  itemsJson: string;
  noteSlug?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESKTOP_CHAT_MAX_BYTES = 2 * 1024 * 1024;
export const DESKTOP_CHAT_TITLE_MAX = 80;
export const DESKTOP_CHAT_RETENTION_DAYS = 90;

/** Upserts a thread: `created_at` is kept from the first save, `updated_at` is `now`. Throws on a
 * non-UUID id or a transcript over DESKTOP_CHAT_MAX_BYTES. */
export function saveDesktopChat(file: string, chat: DesktopChatInput, now: Date = new Date()): void {
  if (!UUID.test(chat.id)) throw new Error("desktop chat id must be a UUID");
  if (Buffer.byteLength(chat.itemsJson, "utf8") > DESKTOP_CHAT_MAX_BYTES) throw new Error("desktop chat is too large to save");
  const at = now.toISOString();
  openDb(file)
    .prepare(
      `INSERT INTO desktop_chats (id, title, created_at, updated_at, items_json, note_slug) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
         items_json = excluded.items_json, note_slug = excluded.note_slug`,
    )
    .run(chat.id, chat.title.trim().slice(0, DESKTOP_CHAT_TITLE_MAX), at, at, chat.itemsJson, chat.noteSlug ?? null);
}

/** Prunes threads not saved in DESKTOP_CHAT_RETENTION_DAYS, then lists the rest newest first. */
export function listDesktopChats(file: string, now: Date = new Date()): DesktopChatSummary[] {
  const db = openDb(file);
  const cutoff = new Date(now.getTime() - DESKTOP_CHAT_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM desktop_chats WHERE updated_at < ?").run(cutoff);
  return db
    .prepare("SELECT id, title, updated_at AS updatedAt FROM desktop_chats ORDER BY updated_at DESC, id")
    .all()
    .map((r) => ({ ...r }) as unknown as DesktopChatSummary);
}

export function getDesktopChat(file: string, id: string): DesktopChat | undefined {
  if (!UUID.test(id)) return undefined;
  const row = openDb(file)
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, items_json AS itemsJson, note_slug AS noteSlug
       FROM desktop_chats WHERE id = ?`,
    )
    .get(id);
  return row ? ({ ...row } as unknown as DesktopChat) : undefined;
}

/** Idempotent: deleting a missing (or non-UUID) id is a no-op. */
export function deleteDesktopChat(file: string, id: string): void {
  if (!UUID.test(id)) return;
  openDb(file).prepare("DELETE FROM desktop_chats WHERE id = ?").run(id);
}
