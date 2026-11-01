# Chatops conversation catalog (#527)

`bean.db`'s `chatops_conversations` (core `chatops/catalog.ts`) lists the chatops conversations
the owner can continue from the desktop (epic #526). Only the bot writes it, on two events:

- a **DM turn whose speaker is the owner** (kind `dm`, title "DM");
- a **live session the owner started** (card tap with `role === "owner"`; kind/title from the
  surface's `CardAction.place`), bound to that session's CLI. A fresh session's id lands only
  after `LiveSessionRegistry` wrote its `delegate_runs` row (a failed write leaves it unset); a
  resume binds its known id up front. A `/new` after launch fences out a late id.

Never catalogued: a member's DM, a member-started session (even with the owner as co-driver),
an owner turn in a channel without a live session. Eligibility is about the owner's own
conversations — a member's DM is private to them.

`owner_id` is the platform id the bot **saw** (Teams: the `29:` id, AAD in `owner_alt_id`),
because live steering compares raw ids (`canSteer`) and the desktop has to act as that id.
`listChatopsConversations` filters by the **current** owner config (either id form), so a
changed owner hides the old owner's rows instead of leaking them.

**No backfill:** `chatops_turns` never stored surface, kind or speaker, so pre-#527 history
can't be attributed to the owner safely; it shows up once the owner speaks there again.

`/new` (`ConversationStore.clear`) re-keys rather than deletes (#600): in a catalogued
conversation with turns it moves them to `<id>~<uuid>` and copies each catalog row there with
`archived_from = <id>` (no live session id, old `updated_at`), then drops `thread_sessions` and
unbinds/bumps the live row — one `BEGIN IMMEDIATE` transaction. Model reads filter by exact id, so
the archive never reaches context. Uncatalogued (member DMs, channels) or empty → hard delete.
Archives are read-only: `onDeskTurn`/`onDeskResume` and app main's `send`/`resume` refuse them
(`no-record`). `listChatopsConversations` prunes archives older than
`DESKTOP_CHAT_RETENTION_DAYS` for **every** owner, plus their turns unless a surviving row still
references the id. A run in flight across `/new` posts its result into the **new** conversation
(results append by the live id), not the archive. History changes
signal through `ConversationStore`'s `onChange` (append / replaceOldest / clear) — the one place
every writer (bot turns, delegate results, compaction, outbox notices) goes through; don't hook
callers individually. New columns follow `convention-bean-db-column-additions.md`.
