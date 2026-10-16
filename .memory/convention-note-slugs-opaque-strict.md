# Note slugs are opaque IDs; updates are strict

New notes get a `randomUUID()` slug — never derive a slug from the title (the old `slugify`
reused deleted slugs, so a chat linked to a deleted note could overwrite a different one).

`saveNote` with a `slug` is an **update**: a missing or archived row throws inside the
transaction, before any `notes_history` write. The only exception is `{ upsert: true }`, used
solely by the routine note sink (`routine-host.ts`, fixed slug `routine-<name>`): it creates a
missing row (clearing orphaned history for that slug) and updates an archived row in place
without restoring it. Don't pass `upsert` from chat/IPC/bot paths.

Lifecycle: `archiveNote`/`restoreNote` only flip `archived_at` (version, history, star, project
untouched); `purgeNote` is archived-only and deletes history then the row. The `ON CONFLICT`
update never touches `archived_at` or `starred`. `loadNotes`/`searchNotes` hide archived notes
by default. The desktop Delete button calls `archiveNote` (#304).
