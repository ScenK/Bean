# Notes — persist a talk, pick it back up

Notes are the deliberate counterpart to memory: **explicit, visible, inert**. Memory is
extracted automatically and silently injected into every prompt; a note is only created via
a user-confirmed card and does nothing until the user clicks "Continue in chat". Keep that
split — never auto-save notes, never inject unlinked notes into prompts.

Mechanics (v1, mockup `Notes.dc.html` in the Claude Design project):

- Storage: `~/.bean/notes/<slug>.md` (`core/src/note-store.ts`), frontmatter
  `title/updated/version/source/project`, freeform markdown body. "Open questions" count =
  unchecked `- [ ]` boxes in the body — a convention prompted via the `propose_note` tool
  description, not a schema.
- Chat → note: `propose_note` is a **confirm-first** proposal tool (like `propose_run`, not
  an action tool) — `ConverseResult.proposedNote` → `NoteCard` in chat → `bean:save-note`.
  The composer's 📝 button just sends an explicit "save this as a note" message.
- Note → chat: "Continue in chat" reuses the chatPrompt store with a `noteSlug`; the chat
  window then holds a `LinkedNote` (header chip). A linked chat's `propose_note` carries the
  slug, so Save **updates in place** (version bump; prior file copied to
  `notes/.history/<slug>.v<n>.md` — updates are never destructive). "Save as new" / chip ✕
  opt out.
- Deliberately cut: "source conversation" link (no transcript persistence exists), history
  browser UI (files are kept, no viewer), open-question badge on the avatar tile.
