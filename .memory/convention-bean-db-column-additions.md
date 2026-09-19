# Adding a column to an existing `bean.db`

`db.ts`'s `SCHEMA` is `CREATE TABLE IF NOT EXISTS`, so a column added to a table that already
shipped **never reaches an existing `~/.bean/bean.db`** — the CREATE is skipped wholesale. The
column needs its own `ALTER TABLE` in `openDb()`, and that migration has two traps:

- **Don't `try { ALTER } catch {}`.** That swallows a lock timeout or I/O error as if it meant
  "column already there", then caches a handle whose table lacks the column — every later query
  fails until restart. Check `PRAGMA table_info(<table>)` instead.
- **The check and the ALTER race across processes.** The app and the Discord/Teams servers open
  the same file; two openers can both see the column missing and the loser's ALTER throws. Do
  the re-check and the ALTER inside `BEGIN IMMEDIATE`/`COMMIT` (see the `notes.starred`
  migration in `db.ts`).

Also: the `notes_fts`/`memories_fts` triggers are external-content FTS5 triggers that fire on
**any** UPDATE of the base table, not just the indexed columns. Narrowing one to
`AFTER UPDATE OF <cols>` means dropping and recreating it on every `openDb()` (same cross-process
race, but this one corrupts an index rather than failing loudly) — not worth it: re-indexing an
unchanged title/body is a no-op. Leave the triggers alone and let them fire. A test fixture that
simulates an older schema must recreate the FTS table and its triggers too, or an UPDATE reports
`database disk image is malformed`.
