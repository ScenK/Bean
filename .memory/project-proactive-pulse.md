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

## Host scheduler and delivery (#1157)

- `@bean/host` `pulse.ts`: `startPulse` checks every 10 min under the scheduler lease (`canRun` =
  lease held, no core update); a pass is due per `PULSE_CADENCE_MINUTES[effective level]` since
  `lastPulseAt` or the last failed try (in-memory, so a failing pass never retries faster). No pass
  in quiet hours at all — a step-down notice would be lost with the post. Lease, dial and quiet
  hours are re-checked after the model call; a dial change mid-pass drops the step-down notice.
  **Dormant behind `PULSE_LIVE = false` until the Settings dial ships (#1158)** — flip it there.
- The dial is read from `config.json` per use (`loadConfig(...).proactivity`, unreadable = off) on
  the host and in the bots; #1158 may move it into runtime-config.
- A check-in is a `home_posts` row with `kind = 'pulse'` and `sprout` = the persona name. Its
  main-log turn is `homePostTurn` (core `home-posts.ts`): assistant role, the body as is — the same
  from the Home drain and from the owner-DM copy (`OutboxMessage.kind = "pulse"` → `appendDelivery`
  `postKind`), under one `post:<id>` key, so arrival order never flips it. The DM copy has no
  `title`/`displayBody` (no `Sprout:` prefix); Teams replies to it resolve to no post (fine).
- Seeds ride Home turns (host, the mount pinned to Home) and the owner's own 1:1 DM (bot `deps.seeds`)
  as one fenced user-role message after the recall (`seedsData`); none when the dial is off.
- Host `handlers.seeds` (`list`/`resolve`/`undo`) carry the version the owner saw and throw on a
  mismatch; `resolve` resets the unanswered streak. Not wired to IPC yet (#1158).
- Pre-cutover Home and the renderer's post bubble still treat a pulse like a sprout post (quoted,
  user role, `[sprout "<name>" posted]`) until #1159 renders it as Bean's own.
