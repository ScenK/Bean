# Per-speaker memory: private facts plus a household pool (#281)

`memories.subject_id` (nullable, added via [convention-bean-db-column-additions](convention-bean-db-column-additions.md))
is the chatops speaker's platform id a fact is private to; NULL = household-shared, so every
pre-#281 row and every desktop/auto-memory save is shared.

- **Recall is filtered in SQL before ranking** — `loadMemories(file, subject)`: absent = all rows
  (desktop + Persona: the owner's own machine, unchanged), `null` = shared only (channels and
  **both** routine hosts: `main.ts` and Discord's `headless-routines.ts`), an id = shared + that
  speaker's (their DMs). Never rank first and filter after: the top-K cut would leak or starve.
  Chime-ins (`chatops/chatter.ts`) load `null` too, re-filter `subjectId` defensively, and strip
  `projectPath` — nobody addressed Bean there, so the recall is for whoever reads the channel.
- **Write scope** — `saveScope(typed, direct)` in `memory/tools.ts`: DM → private, channel →
  shared; "just for me" / "for everyone" override. The id is `msg.fromId` only (never a name).
- **Delete** — `deleteMemories(file, ids, subject)`: non-owners pass their own id and the SQL
  `AND subject_id = ?` means they can drop only their own private rows (not shared, not another
  member's); the owner passes nothing. Both the `forget_memory` tool and the Forget card go
  through it — keep the check in SQL, not in the caller's id list.
- **Share** (#354) — `shareMemory(file, id, actor)`: `UPDATE … SET subject_id = NULL WHERE id = ?
  AND subject_id = ?`, so only the row's author can share it — **the owner included** (no bypass;
  forgetting is where the owner has power). Text, project and `created_at` stay, so the recall
  date still reflects when it was said. Once shared, only the owner can forget it.
- **Dream never sees private rows**: `maybeDream` loads `null` and `countMemoriesSince` counts
  shared only. `memories_history` has no `subject_id`, so a private row merged/undone by dream
  would come back shared — don't widen dream without adding the column there. Dream stays off on
  the headless host (only the desktop triggers it).
- **Recall is dated** (#352): `memoriesBlock()` suffixes every line with `(saved YYYY-MM-DD HH:MM UTC)`
  from `createdAt` (`(saved unknown)` if it doesn't parse), and both the default header and
  `ROUTINE_MEMORY_HEADER` carry `MEMORY_CONFLICT_CLAUSE` (later-saved wins). It stays in the
  trailing context message — never move it into the leading (cached) system message.
