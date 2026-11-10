import { openDb } from "./db.js";

/** A desktop chat thread as listed in the history picker — no transcript. */
export interface DesktopChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** A listed thread plus the live agents that replied in it (`reply` items' `agent`), for the picker. */
export interface DesktopChatListing extends DesktopChatSummary {
  agents: string[];
  /** Starred threads are exempt from the retention prune. */
  starred: boolean;
  /** The starred thread's named group; null = ungrouped. Only starred threads have one. */
  groupName: string | null;
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

/** Upserts a thread: `created_at` and `title` are kept from the first save (a rename is the only
 * later writer of `title`), `updated_at` is `now`. Returns the stored title. Throws on a non-UUID id
 * or a transcript over DESKTOP_CHAT_MAX_BYTES. */
export function saveDesktopChat(file: string, chat: DesktopChatInput, now: Date = new Date()): string {
  if (!UUID.test(chat.id)) throw new Error("desktop chat id must be a UUID");
  if (Buffer.byteLength(chat.itemsJson, "utf8") > DESKTOP_CHAT_MAX_BYTES) throw new Error("desktop chat is too large to save");
  const at = now.toISOString();
  const row = openDb(file)
    .prepare(
      `INSERT INTO desktop_chats (id, title, created_at, updated_at, items_json, note_slug) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
         items_json = excluded.items_json, note_slug = excluded.note_slug
       RETURNING title`,
    )
    .get(chat.id, chat.title.trim().slice(0, DESKTOP_CHAT_TITLE_MAX), at, at, chat.itemsJson, chat.noteSlug ?? null);
  return row!.title as string;
}

/** The one name rule for thread titles and group names: collapsed to one line, trimmed, capped at
 * DESKTOP_CHAT_TITLE_MAX. Throws when nothing is left. Group identity is the exact (case-sensitive)
 * result. */
export function desktopChatName(name: string, what = "desktop chat title"): string {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, DESKTOP_CHAT_TITLE_MAX).trim();
  if (!clean) throw new Error(`${what} can't be empty`);
  return clean;
}

/** Renames a thread (see desktopChatName). Returns the stored title, or undefined for a missing or
 * non-UUID id (never inserts). Leaves `updated_at` and `starred` alone. */
export function renameDesktopChat(file: string, id: string, title: string): string | undefined {
  if (!UUID.test(id)) return undefined;
  const clean = desktopChatName(title);
  const row = openDb(file).prepare("UPDATE desktop_chats SET title = ? WHERE id = ? RETURNING title").get(clean, id);
  return row ? (row.title as string) : undefined;
}

const retentionCutoff = (now: Date): string => new Date(now.getTime() - DESKTOP_CHAT_RETENTION_DAYS * 86_400_000).toISOString();

/** Prunes unstarred threads not saved in DESKTOP_CHAT_RETENTION_DAYS, then lists the rest newest first. */
export function listDesktopChats(file: string, now: Date = new Date()): DesktopChatListing[] {
  const db = openDb(file);
  db.prepare("DELETE FROM desktop_chats WHERE updated_at < ? AND starred = 0").run(retentionCutoff(now));
  // Agents are read in SQL so the picker never ships transcripts; a non-JSON row lists none.
  return db
    .prepare(
      `SELECT id, title, updated_at AS updatedAt, starred, group_name AS groupName,
         (SELECT group_concat(agent) FROM (SELECT DISTINCT json_extract(j.value, '$.agent') AS agent
            FROM json_each(CASE WHEN json_valid(items_json) THEN items_json ELSE '[]' END) j
            WHERE json_extract(j.value, '$.kind') = 'reply' AND json_extract(j.value, '$.agent') NOT IN ('bean'))) AS agents
       FROM desktop_chats ORDER BY updated_at DESC, id`,
    )
    .all()
    .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, agents: typeof r.agents === "string" ? r.agents.split(",") : [], starred: r.starred === 1,
      groupName: typeof r.groupName === "string" ? r.groupName : null }) as DesktopChatListing);
}

/** Sets a thread's star; returns its `updated_at`, or undefined for a missing or non-UUID id (never
 * inserts). Unstarring also clears its group (re-starring doesn't restore it). Unstarring a starred
 * thread already past the prune cutoff resets `updated_at` to `now`, so it isn't deleted on the next
 * listing; otherwise `updated_at` is untouched. */
export function starDesktopChat(file: string, id: string, starred: boolean, now: Date = new Date()): string | undefined {
  if (!UUID.test(id)) return undefined;
  // SET expressions read the pre-update row, so `starred = 1` here is the old value.
  const row = openDb(file)
    .prepare(
      `UPDATE desktop_chats SET starred = ?, group_name = CASE WHEN ? = 0 THEN NULL ELSE group_name END,
         updated_at = CASE WHEN ? = 0 AND starred = 1 AND updated_at < ? THEN ? ELSE updated_at END
       WHERE id = ? RETURNING updated_at AS updatedAt`,
    )
    .get(starred ? 1 : 0, starred ? 1 : 0, starred ? 1 : 0, retentionCutoff(now), now.toISOString(), id);
  return row ? (row.updatedAt as string) : undefined;
}

/** Puts threads in a named group, starring them too; `null` ungroups them and keeps the star. One
 * statement. Returns the ids it updated — missing and non-UUID ids are skipped (never inserts);
 * `updated_at` is untouched. Throws on an invalid name (see desktopChatName). */
export function groupDesktopChats(file: string, ids: string[], name: string | null): string[] {
  const group = name === null ? null : desktopChatName(name, "group name");
  const valid = ids.filter((id) => UUID.test(id));
  if (valid.length === 0) return [];
  return openDb(file)
    .prepare(
      `UPDATE desktop_chats SET group_name = ?, starred = CASE WHEN ? IS NULL THEN starred ELSE 1 END
       WHERE id IN (SELECT value FROM json_each(?)) RETURNING id`,
    )
    .all(group, group, JSON.stringify(valid))
    .map((r) => r.id as string);
}

/** Renames a group: every thread in `from` moves to `to` (onto an existing name, they merge).
 * Returns the moved ids. Throws on an invalid name (see desktopChatName). */
export function renameDesktopChatGroup(file: string, from: string, to: string): string[] {
  const src = desktopChatName(from, "group name");
  const dst = desktopChatName(to, "group name");
  return openDb(file)
    .prepare("UPDATE desktop_chats SET group_name = ? WHERE group_name = ? RETURNING id")
    .all(dst, src)
    .map((r) => r.id as string);
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
