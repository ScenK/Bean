# chatops memory capture

Teams/Discord bots can save durable memories via a confirm-first card, mirroring the notes flow.

- Trigger: a **gated** `propose_remember` tool in `converse()` (argless). Enabled only when
  `rememberAvailable` is passed (the bot passes `true`; the desktop app does NOT, so its
  extract-at-close review stays the only desktop memory path — don't remove the gate).
- The tool is a trigger only: the model decides WHEN, `extractMemories()` (run by `bot.ts`)
  decides WHAT.
- Selection is normalized to `CardAction.value.memoryPicks` (fact indices). **undefined = all**
  — this is how Discord's untouched (all-default-selected) select menu is handled. Teams always
  sends explicit `fact-<i>: "true"` toggles.
- `MemoryProposalStore.claim()` is one-shot (like NoteProposalStore) so two people tapping
  Remember can't double-save.
- Saving a confirmed batch calls `deps.appendMemories()` (insert-only), not `saveMemories()` —
  see [[safety-memory-append-vs-replace]]. `saveMemories` (whole-list replace) is reserved for
  consolidation's merge/drop apply, which is a genuine read-modify-write and is gated behind a
  one-shot claimed proposal.
- `ConversationStore` (`chatops/conversation.ts`) is now `bean.db`-backed (`chatops_turns` table)
  instead of an in-memory `Map` — history survives a bot restart. `bot.ts` fires
  `maybeCompact()` (`chatops/compact.ts`) after every reply, fire-and-forget: above 60 raw turns
  it summarizes the oldest 40 into one `role: "system"` turn via a `deps.chat()` call. This is
  silent/automatic (no confirm card) — same "old context eventually falls away" tradeoff as the
  previous in-memory `MAX_TURNS=40` slice, just smarter.
- Memory consolidation (merge duplicates/drop stale) piggybacks on this same save-memories path —
  see project-bean-memory.md's Consolidation section.
