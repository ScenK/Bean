# Notes — persist a talk, pick it back up

Notes are the deliberate counterpart to memory: **explicit, visible, inert**. Memory is
extracted automatically and silently injected into every prompt; a note is only created via
a user-confirmed card and does nothing until the user clicks "Continue in chat". Keep that
split — never auto-save notes, never inject unlinked notes into prompts.

Mechanics (v1, mockup `Notes.dc.html` in the Claude Design project):

- Storage: `~/.bean/bean.db` (SQLite, `core/src/db.ts` + `core/src/note-store.ts`) — a `notes`
  table (slug/title/body/project/updated/version/source) plus `notes_fts` (FTS5, backs
  `searchNotes()`/`retrieve_note`) and `notes_history` (prior versions, replacing the old
  `notes/.history/<slug>.v<n>.md` files). Migrated once from the legacy `notes/*.md` +
  `.history/*.md` files on first `openDb()` call (see project-bean-memory.md). "Open questions"
  count = unchecked `- [ ]` boxes in the body, computed at read time — a convention prompted via
  the `propose_note` tool description, not a schema.
- Search: `retrieveNoteTool` takes a `searchNotes(query)` fn (not a `loadNotesFn`) — an FTS5
  `MATCH` over title+body built as an OR of per-word prefix queries (`"word"*`), ranked by
  `bm25()`. Preserves the old JS word-match's "any shared word surfaces the note, not a
  whole-phrase match" contract; the one behavior narrowing is prefix-only matching (old
  `.includes()` could match mid-word, e.g. "map" inside "roadmap" — FTS5 prefix can't).
- Chat → note: `propose_note` is a **confirm-first** proposal tool (like `propose_run`, not
  an action tool) — `ConverseResult.proposedNote` → `NoteCard` in chat → `bean:save-note`.
  The composer's 📝 button just sends an explicit "save this as a note" message.
- Note → chat: "Continue in chat" reuses the chatPrompt store with a `noteSlug`; the chat
  window then holds a `LinkedNote` (header chip). A linked chat's `propose_note` carries the
  slug, so Save **updates in place** (version bump; prior row copied into `notes_history` —
  updates are never destructive, `saveNote`'s `BEGIN IMMEDIATE` transaction makes the read-then-
  write atomic against a concurrent save of the same slug). "Save as new" / chip ✕ opt out.
- Deliberately cut: "source conversation" link (no transcript persistence exists), history
  browser UI (files are kept, no viewer), open-question badge on the avatar tile.
