# chatops memory

Teams/Discord bots remember only on an explicit ask (background extraction there is deferred
to #178 — group channels mix several people's words, and chatops has no "conversation end").

- `bot.ts` builds `makeMemoryTools()` (core `memory/tools.ts`) per converse turn with
  `latestUserText: msg.text` — the addressed person's own typed text is the only citable source.
  The chat-skill follow-up hop reuses `converseBase` *without* these tools (its latest text is a
  composed prompt, not the user's words).
- Both tools are intent-gated in code (`makeMemoryTools`): `remember` is offered only when the
  typed text says remember/keep in mind/note that, `forget_memory` only on forget/delete/remove —
  so injected page or delegate text on an ordinary turn can't save or delete. The quote must
  support *every* content word of the fact (`supports()` in extract.ts), not just share one.
- `remember` saves directly (no confirm card); each saved fact gets a `rememberedCard` receipt
  with a **Forget** button. The button carries the memory id in the generic `proposalId` slot
  (`bean:forget-memory:<uuid>` on Discord, ~55 of 100 custom_id chars); delete is idempotent, so
  no proposal store — a second tap says "Already forgotten."
- `forget_memory(ids)` is the text-command equivalent; ids come from the `[id]`-tagged recall
  block in `converse()`.
- `ConversationStore` (`chatops/conversation.ts`) is `bean.db`-backed (`chatops_turns`); `bot.ts`
  fires `maybeCompact()` after every reply — above 60 raw turns the oldest 40 become one
  `role: "system"` summary. Silent/automatic (pure efficiency, not a memory decision).
- Memory consolidation (merge/drop) still piggybacks on a remember that pushes the list past 30 —
  see project-bean-memory.md.
