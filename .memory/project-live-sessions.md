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
- **Two real concurrency bugs found by review, now fixed**: (1) the rollover-split loop used
  to truncate the buffer *before* the network call that persisted the truncated chunk
  succeeded, so a rejected send (rate limit) permanently dropped up to ~1900 chars; (2)
  `teardown()` could fire `onEnded` while a flush was still in-flight, because
  `flushSession`'s own `rendering` guard made the teardown-triggered call a silent no-op.
  Both fixed by tracking the in-flight flush as a promise (`ActiveSession.inFlight`) and
  never truncating the buffer until the corresponding send resolves. If you touch
  `flushSession`/`teardown` again, re-derive these invariants — they're easy to reintroduce.
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
- Feature is invisible unless `~/.bean/config.json` has `"liveSessions": true` AND `claude`
  is detected on PATH (`liveSessionsEnabled` checks both). Launch is always confirm-first via
  a card even though the session itself runs with permissions bypassed once started.
- Manual end-to-end smoke test (real Discord bot + real `claude` CLI) was not run as part of
  the implementation — it needs live Discord credentials and a test server that weren't
  available in the implementing session. Full monorepo test/typecheck gate is green; the
  interactive loop (proposal card → start → streaming → steer → stop → crash-path) still
  needs a human to drive once against a real bot.
