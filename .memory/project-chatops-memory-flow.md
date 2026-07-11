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
