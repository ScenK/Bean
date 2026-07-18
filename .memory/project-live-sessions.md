# Live sessions (chat-bridged interactive agent)

Chat-bridged multi-turn Claude Code sessions, Discord-first. Spec:
`docs/superpowers/specs/2026-07-18-live-sessions-design.md`.

- `core/live-session.ts` = multi-turn sibling of `delegate.ts`: a long-lived
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --dangerously-skip-permissions` process, user turns written as JSON lines to stdin, one
  `result` event per turn. The permissions bypass is a **deliberate spec decision** (true
  bypass, explicitly stronger than the desktop UI's "Auto" mode, which still prompts on
  dangerous actions) — do not "fix" it into a safer mode without re-checking the spec; the
  war-room use case (a whole channel steering a shell-capable agent on the host Mac) already
  accepted this risk in exchange for zero-friction streaming.
- `chatops/live-sessions.ts` `LiveSessionRegistry` binds channelId → session. While bound,
  `bot.onMessage` routes the channel's messages straight to the session (bypassing
  `converse()` entirely) until someone says `stop` or the 30-minute idle timeout fires. The
  render buffer is the source of truth: a failed Discord post/edit retries on the next
  ~1.5s tick without losing content — but this took a real bug fix to get right (see below).
- **Three real concurrency bugs found by review, now fixed** — all in the same class (async
  work racing new output arriving mid-flight):
  1. The rollover-split loop truncated the buffer *before* the network call that persisted
     the truncated chunk succeeded, so a rejected send (rate limit) permanently dropped up
     to ~1900 chars.
  2. `teardown()` could fire `onEnded` while a flush was still in-flight, because
     `flushSession`'s own `rendering` guard made the teardown-triggered call a silent no-op.
  3. (Found post-merge by an automated PR reviewer.) On a turn-closing send
     (`closeAfterFlush`), any output that arrived *while that send was still awaited* got
     silently wiped by a blind `s.buf = ""` reset once the send resolved — the reset assumed
     `s.buf` still equaled what was just sent, which isn't true if the next turn's first
     token arrived in the meantime.
  Fixed by: tracking the in-flight flush as a promise (`ActiveSession.inFlight`); never
  truncating the buffer until the corresponding send resolves; and, for the turn-closing
  reset specifically, slicing off only the sent-length prefix (captured right before that
  send) instead of resetting to `""`. **Important asymmetry to preserve if you touch
  `flushSession` again**: `s.buf` for a *continuing* (non-closing) send is the message's full
  cumulative content and must NOT be truncated after an ordinary send — only the rollover
  loop (each chunk becomes its own finalized message) and the `closeAfterFlush` reset (the
  message is actually ending) ever remove sent content from it.
- The stream sink rides `BotEffects`: `postCard({content})` / `updateCard(id, {content})`.
  This works on Discord (plain `MessageCreateOptions`) but NOT on Teams (adaptive-card
  attachment shape) — which is why Teams wires the feature but hard-disables it
  (`liveSessionsEnabled: () => false`). Enabling Teams needs a real text-post-and-edit path
  there first, not just flipping the flag.
- Teams' `cards.ts` has **no combined exported `CardBuilders` object** — every card is an
  individually-exported function, and `teams/server.ts` builds its own inline `cards: {...}`
  object literal from those imports. Discord's `components.ts` is the opposite (a single
  exported `discordCards: CardBuilders`). Don't assume one pattern when touching the other
  surface's card file — this exact mismatch caused a broken typecheck mid-build (see git
  history around commit range `482d173..c7c0050`).
- Feature defaults to **on** (`liveSessions` defaults to `true` in `loadConfig` — changed
  from the original opt-in/`false` design by explicit request after the initial build), and
  still requires `claude` to be detected on PATH (`liveSessionsEnabled` checks both). An
  explicit opt-out is respected: `saveConfig` preserves the on-disk `liveSessions` value when
  a caller omits the field (the desktop Settings save has no toggle for it and would
  otherwise silently reset it on every save — this was a real, review-caught bug). Launch is
  always confirm-first via a card even though the session itself runs with permissions
  bypassed once started.
- Manual end-to-end smoke test (real Discord bot + real `claude` CLI) was not run as part of
  the implementation — it needs live Discord credentials and a test server that weren't
  available in the implementing session. Full monorepo test/typecheck gate is green; the
  interactive loop (proposal card → start → streaming → steer → stop → crash-path) still
  needs a human to drive once against a real bot.
