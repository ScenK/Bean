# Proactive pulse and Seeds (#1155 epic; core in #1156)

- `runProactivePulse` (core `pulse.ts`) is one `deps.chat` call with `tools: []`, `webSearch: false`;
  any returned tool call throws and nothing is written. Only `PULSE_SYSTEM` is system; sprout runs,
  memories, main-log turns and Seeds go in user messages, fenced (`quoteFence` on the whole body).
- Memory is read `loadMemories(file, ownerSubjectIds)` (default scope): shared + owner rows,
  unexpired, no channel captures. Never the unscoped call — it returns every speaker's rows.
- Sprout history comes only from `feedBrain: true` routines, read with
  `loadRoutineStates(file, true)`: a throw = history unavailable, and that pass resolves nothing.
  `feedBrain` is stripped by `draftHome` outside the owner's 1:1; the builder never emits it.
- `mind_items.version` bumps on every write; pulse writes carry the snapshot's version, owner
  Done / Let it go / Undo don't — so the owner always wins. `reconciled_at` = the pulse's last write;
  `updated_at > reconciled_at` means the owner touched it (counts as answering a check-in).
- Auto-backoff never rewrites `config.proactivity`: `memory_meta.pulseState.lowered = {from, to}`
  applies only while the dial still reads `from`, so any owner dial change ends it. The host
  calls `notePulsePosted` after delivering a check-in — not for the backoff announcement.
- Quiet hours (22:00–07:00 local) and the daily cap (`home_posts.kind = 'pulse'` since local
  midnight) gate only the post; Seeds still update.
