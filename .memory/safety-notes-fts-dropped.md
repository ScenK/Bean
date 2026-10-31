# `notes_fts` is gone — keep `openDb()` re-dropping it

Note search moved (#572) from the trigger-backed external-content `notes_fts` to `notes_search`:
a plain FTS5 table keyed by `notes.rowid`, holding `cjkBigrams()`-transformed title/body
(`core/src/fts-text.ts`), written by `saveNote`/`purgeNote` in the same transaction as the base
row — no triggers. Archived notes stay indexed (`searchNotes` filters them).

An **older Bean build** opening the same `~/.bean/bean.db` recreates `notes_fts` and its three
triggers from its `SCHEMA`; the empty external-content index then makes every note UPDATE fail
with `database disk image is malformed`, and notes it inserts never reach `notes_search`.
`migrateNoteSearch()` (`db.ts`) therefore runs on **every** open: any `notes_fts`/`notes_a[idu]`
left in `sqlite_master` → drop them and rebuild `notes_search`. Don't remove that check, don't put
`notes_search` into `SCHEMA` (its absence is the "needs backfill" marker), and don't add a trigger
calling a JS-registered SQL function (a process that hadn't registered it fails every write).
Accepted risk: until a new build reopens the file, note saves fail — a separately deployed bot on
the same machine must be updated together with the app.

Why bigrams: `unicode61` makes an unspaced CJK run one token (`牙医` never matches inside
`我的牙医是张医生`), and `trigram` can't match the 2-char queries most Chinese words are. Known
limit: a one-character query can't match a run's last character. `memories_fts` still exists but
nothing in production reads it — recall ranks in a scratch table in `selectRelevantMemories`.
