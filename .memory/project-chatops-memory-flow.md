# chatops memory

Teams/Discord bots remember on an explicit ask anywhere, automatically in DMs (#462, private),
and from un-addressed channel/thread chatter (#463, household-shared).

- **Channel capture** (`chatops/ambient-capture.ts`, fed by `bot.onAmbient`'s `AmbientLine` at both
  surfaces' ambient call sites — independent of `chatty`): buffers per conversation, extracts after a
  30 s lull / 2 min max (an addressed turn flushes it). Citable = member+ (`can(role, "memory")` on
  the platform id), not a bot, not a `>` quoted line; a guest-only batch makes no model call. Each
  fact's quote must match **exactly one** eligible line (ambiguous or cross-speaker quotes are
  dropped); that line's speaker is bound: owner → plain text, anyone else → `Name: fact`. Saved
  shared (`subject_id` NULL). `memory on|off|status` (`chatops_chatty.memory_off`, missing row = on;
  on/off = `channelMemory`, admin; channel scope) and `autoMemory` are re-checked right before the
  insert, so a queued batch obeys them. Receipt: Discord 🧠 reaction (best-effort), Teams silent;
  the first save per scope posts `MEMORY_NOTICE` once (`memory_noticed`, atomic upsert). Daily cap
  48 calls / 20 saves per scope is in-process (a restart resets it).

- **DM auto-capture** (`captureDm` in `bot.ts`): after a DM reply, core's per-turn
  `extractMemories(..., { latestTurn: true })` runs on the speaker's `typedText` only (the audio
  transcript is never the citable turn; prior history rides along as non-citable context). Gated
  by `can(role, "memory")` (so guests, even with `allowGuestDms`, never capture), a non-failed
  turn, and a turn that used neither `remember` nor `forget_memory` (a "forget that I live in X"
  turn must not re-save X). Rows are saved with `subjectId` = speaker (always private) and each
  gets the normal `rememberedCard` (Forget + Share). Captures run on one serialized chain so each
  sees the last one's rows; `onMessage`'s `finally` awaits it because Teams' `postCard` rides the
  turn's `context`, which is revoked once the handler returns — don't detach it.
- Config `autoMemory` gates DM capture only (explicit tools stay on): `deps.autoMemoryEnabled`,
  which each server wires to a per-turn `loadConfig` re-read (unreadable = off), so a Settings
  toggle applies without restarting the bot.

- `bot.ts` builds `makeMemoryTools()` (core `memory/tools.ts`) per converse turn with
  `latestUserText: msg.text` — the addressed person's own typed text is the only citable source.
  The chat-skill follow-up hop reuses `converseBase` *without* these tools (its latest text is a
  composed prompt, not the user's words).
- Both tools are intent-gated in code (`makeMemoryTools`): `remember` is offered only when the
  typed text says remember/keep in mind/note that, `forget_memory` only on forget/delete/remove —
  so injected page or delegate text on an ordinary turn can't save or delete. The quote must
  support *every* content word of the fact (`supports()` in extract.ts), not just share one.
- Scope (#281, [safety-per-speaker-memory](safety-per-speaker-memory.md)): a DM saves private to
  the speaker, a channel to the household; the receipt says which.
- `remember` saves directly (no confirm card); each saved fact gets a `rememberedCard` receipt
  with a **Forget** button. The button carries the memory id in the generic `proposalId` slot
  (`bean:forget-memory:<uuid>` on Discord, ~55 of 100 custom_id chars); delete is idempotent, so
  no proposal store — a second tap says "Already forgotten."
- A **private** receipt also gets **Share with everyone** (`bean:share-memory:<uuid>` / Teams
  `beanAction: "share-memory"`), gated `needs("memory")` before the store is touched. Author-only
  (SQL `AND subject_id = actor`, owner included), same no-proposal-store shape: 0 rows changed →
  "Nothing changed — already shared or forgotten." with no fact text; the success reply quotes the
  stored row, never the card payload. The model gets no share tool — a private `remember` result
  just tells it to point at the button when the fact updates a household one.
- `forget_memory(ids)` is the text-command equivalent; ids come from the `[id]`-tagged recall
  block in `converse()`.
- `ConversationStore` (`chatops/conversation.ts`) is `bean.db`-backed (`chatops_turns`); `bot.ts`
  fires `maybeCompact()` after every reply — above 60 raw turns the oldest 40 become one
  `role: "system"` summary. Silent/automatic (pure efficiency, not a memory decision).
- `IncomingMessage.typedText`: Discord appends audio transcripts to `text`; a clip may be a third
  party's recording, so the adapter passes the typed part separately and only it feeds the tools.
- No chatops consolidation card anymore (deleted in #177) — see project-bean-memory.md.
