# Memory writes are insert-only or per-row — never list+replace

`saveMemories(file, memories)` is a **whole-list replace** (delete-all + reinsert). SQLite's
locking only covers one statement/transaction, not two JS-level calls, so any
`loadMemories → mutate in JS → saveMemories` round trip loses a concurrent writer's change.
Verified with a throwaway script against the built `dist/`: two concurrent list+save round trips
lost one write; two concurrent `appendMemories` calls did not.

With automatic memory (#177) there are always background writers — auto-remember at chat close
(desktop main), the `remember`/`forget_memory` tools (every surface), and the Persona panel — so
the rule is now absolute for everything except consolidation apply:

- adding facts → `appendMemories` (insert-only);
- editing one → `updateMemory(id, text)`; removing → `deleteMemories(ids)` (idempotent);
- the Persona panel uses only those three (the old `saveMemories` IPC channel is gone).

`saveMemories` itself is **deleted**, and so is the chatops consolidation apply that last used
it (a stale card could overwrite a newer edit even with targeted deletes). Don't reintroduce a
whole-list replace; a "rewrite the set" need goes through one transaction that verifies each
touched row is unchanged since it was read.
