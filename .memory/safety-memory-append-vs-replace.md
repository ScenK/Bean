# saveMemories vs appendMemories — don't collapse these back into one

`saveMemories(file, memories)` is a **whole-list replace** (delete-all + reinsert, one
transaction). Moving memory storage to SQLite (`~/.bean/bean.db`) does **not**, by itself, fix
the multi-process lost-update race this was supposed to close: SQLite's transaction/locking
guarantees only cover a single statement or transaction, not two separate JS-level calls. The
desktop app's chat-close review and a chatops bot's `propose_remember` flow both used to do
`list → compute additions in JS → save the merged array` — two concurrent instances of that
three-step round trip can each read the same snapshot, and whichever writes last silently drops
the other's addition. This is exactly the same shape of race whether the backing store is
`memory.json` or a SQLite table; the storage engine change didn't touch it. Verified with a
throwaway script hitting the built `dist/` output: two concurrent `list+save` round trips lost
one write; two concurrent `appendMemories` calls did not.

The fix: `appendMemories(file, additions)` in `core/src/memory/store.ts` is insert-only, no read
step — two concurrent callers each just insert their own new rows, and SQLite serializes the two
`INSERT` transactions with no data loss. Every path that's *adding new facts* (chatops
`bot.ts`'s `handleMemoryAction`, desktop `ChatWindow.tsx`'s `rememberSelected`) must call
`appendMemories`/`window.bean.appendMemories`, never `listMemories` + `saveMemories`.

`saveMemories` (whole-list replace) is still correct and still needed for the cases that are
genuinely a read-modify-write over the full set: the persona panel's Settings-editable memory
list (single actor editing arbitrarily — not a concurrent-writer scenario), and consolidation's
merge/drop apply (`bot.ts`'s `handleConsolidationAction`, gated behind a one-shot claimed
`ConsolidationProposalStore` proposal so it can't double-apply). Don't "simplify" either of those
back onto `saveMemories`-only, and don't route new-fact-adding call sites through `saveMemories`
even though its signature looks like it'd work — it will, until two processes race.
