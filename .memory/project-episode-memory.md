# Episode memory: Bean writes memory per conversation, in its own words

Owner decision (2026-11-18): **experience outranks code-level gating** for memory. The old
design saved one quoted sentence per fact, checked word-by-word against what the owner typed; the
store filled with fragments ("Done.", "OK", "60 minutes should be fine") and could not hold what
matters — a correction turned into a rule, or a plan agreed across two speakers. Don't bring the
quote/`backedBy` validation, `ABOUT_BEAN`, the rule-shaped reject, or per-turn capture back
without asking.

- **Unit = an episode.** `synthesizeEpisode()` (`core/src/memory/extract.ts`) makes one model call
  over a numbered conversation — every speaker, agent output included; lines above `--- new ---`
  were reviewed before and are context. The model writes each memory as one self-contained
  sentence (who proposed, who agreed, absolute dates). The bar is one question: would it change
  how Bean helps next week, in another conversation? Most episodes yield nothing.
- **Triggers.** Desktop: `EPISODE_IDLE_MS` (10 min) after the chat's last turn
  (`chat-sessions.ts` timer → `memory.rememberIdle`, receipt = the chat's "Memory updated · Undo"
  row), or sooner at a switch-away / close / quit (`rememberOnClose`, which waits for an idle
  episode in flight). Covered turn ids ride later as context, so nothing is written twice.
  Channels and group chats: `ambient-capture.ts`, 10 min idle / 60 min max / an addressed turn.
  `BEAN_EPISODE_IDLE_MS` overrides the desktop wait (e2e uses it).
- **Chatops DMs are still per turn** (`captureDm`, `latestTurn`): Teams' reply context is gone
  by the time a lull would fire, so the receipt card couldn't post. Same synthesis, one new line.
- **What code still checks** (`validateCandidate`): non-empty, one line, ≤600 chars, a known
  project, a future `expires`; a recognizable credential prefix is redacted in place;
  override-shaped text (ignore previous…, bypass confirmation, system prompt) is refused. The real
  safeguards are elsewhere and invisible: recall is framed data with no authority
  ([safety-saved-text-never-system](safety-saved-text-never-system.md)), scope is filtered in SQL,
  incognito / `memory off` / `autoMemory` are re-checked right before the insert, every save has
  an Undo or a Forget.
- **The bar is a human assistant's notebook, not task utility** (owner decision 2026-11-22, after
  reading the first 54 rows): design decisions ("last time you decided…") and moments that
  mattered ("glad Bean closed its 100th ticket") are kept on purpose. Storing more costs little —
  recall injects only the top 30 plus the pinned `You` rows — so don't tighten the prompt to
  drop them. The real costs are staleness and retrieval, handled by `kind` below.
- **`kind`** (nullable; `MEMORY_KINDS` = preference / decision / moment / plan; NULL = a plain
  fact and every older row): the model picks it. Recall renders a decision as
  `[decision, noted <date>] …` and a moment as `[moment, noted <date>] …` (the day Bean saved it —
  no event date is stored), and the header tells the model to say when it noted a decision,
  since it may have changed. Dream merges within one kind only,
  drops an earlier decision a later one replaces, never drops a moment, and refuses a merge
  longer than `MEMORY_TEXT_MAX` (600) — a refused merge leaves its rows as they were. The prompt
  keeps a decision tied to what it was about ("For Bean triage, Scen chose…"); only a correction
  of how Bean worked is generalized into a rule. `category` is a topic label, never "fact".
- **`expires_at`** (nullable): the model sets it for a plan, appointment or deadline. Scoped
  reads filter it in SQL, desktop recall in `selectRelevantMemories`; recall shows
  `(relevant until …)`. `purgeExpiredMemories` deletes rows two weeks past it (called by
  `maybeDream`). Dream never merges a dated row — `memories_history` doesn't carry the column.
- **`evidence`** (nullable, ≤300 chars): a snapshot of the lines the model cited. Provenance for
  debugging a wrong memory; never a gate, never shown at recall, not in Persona yet.
- **Channel rows stay in their channel.** A row with `source_id` is recalled in that conversation
  (`loadMemories(file, subject, { source })`) and on the owner's own surfaces (`allSources`:
  desktop, owner DM, routines, dream) — not in another channel, a member's DM, or a chime-in
  elsewhere. An owner's "OK" to a colleague must not resurface in someone else's DM.
- **Not done yet:** addressed channel turns and Bean's own replies aren't part of a channel
  episode (only un-addressed lines are buffered); the channel buffer and the desktop idle timer
  are in memory, so a restart inside the 10 minutes loses that episode (desktop close still
  catches up); `context` labels are no longer written (old rows keep theirs).
