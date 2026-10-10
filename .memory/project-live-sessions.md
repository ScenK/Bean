# Live sessions (chat-bridged interactive agent)

Chat-bridged multi-turn Claude Code or Codex sessions, Discord-first. Spec:
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
- The stream sink rides `BotEffects`, preferring the optional **`postStream(text)→id` /
  `editStream(id,text)`** text effects, falling back to `postCard({content})` /
  `updateCard(id,{content})` when a surface omits them. Discord omits them — its `postCard`
  takes plain `MessageCreateOptions` so `{content}` already IS a text message. **Teams MUST
  supply `postStream`/`editStream`** (real `sendActivity({text})` / `updateActivity`), because
  its `postCard` wraps the arg as an adaptive-card attachment and `{content: text}` is not a
  valid AdaptiveCard — it would render broken. This is why Teams was originally hard-disabled;
  it is now **enabled** (`liveSessionsEnabled: () => clis.includes("claude")`, same as Discord)
  with those effects wired. Both Teams stream effects post **proactively**
  (`continueConversationAsync`), not on the turn context — turns stream in after the triggering
  turn's context is dead, and a stale-context send is silently dropped (same reason Teams'
  `post`/`updateCard` already go proactive). Do not re-route the live stream through `postCard`
  on Teams.
- Teams' `cards.ts` has **no combined exported `CardBuilders` object** — every card is an
  individually-exported function, and `teams/server.ts` builds its own inline `cards: {...}`
  object literal from those imports. Discord's `components.ts` is the opposite (a single
  exported `discordCards: CardBuilders`). Don't assume one pattern when touching the other
  surface's card file — this exact mismatch caused a broken typecheck mid-build (see git
  history around commit range `482d173..c7c0050`).
- Gating differs by surface. **Desktop** is invisible unless `~/.bean/config.json` has
  `"liveSessions": true` AND `claude` is on PATH (`liveSessionsEnabled` checks both).
  `saveConfig` preserves the on-disk `liveSessions` value when a caller omits the field (the
  desktop Settings save has no toggle for it and would otherwise silently reset it to `false`
  on every save — a real, PR-review-caught bug). **Discord** deliberately dropped the config
  opt-in: `liveSessionsEnabled: () => clis.includes("claude")` — always on when claude is
  present, since the allowlist + the confirm-first card are the authorization boundary there.
  Launch is always confirm-first via a card even though the session itself runs with
  permissions bypassed once started.
- On Discord, `allowedUserIds` gates all normal chat with Bean — but **an active live session
  in a channel is itself the authorization boundary for steering it**: any non-bot message in
  a capturing channel reaches the session regardless of the allowlist (explicit decision —
  matches the spec's "anyone in the bound channel" pitch literally, not just allowlisted
  operators). This bypass is scoped to `messageCreate` only; `interactionCreate` (the
  start-live/cancel-live card buttons — i.e. who can *launch* a session) still requires the
  allowlist unconditionally. Don't accidentally widen the interaction-handler gate to match.
- Discord's SIGTERM shutdown handler calls `liveSessions.forceKillAll()`, not `stopAll()` —
  `stop()`'s graceful SIGTERM-then-SIGKILL-after-5s escalation relies on a `setTimeout` that
  would never fire before `process.exit()` runs immediately after, orphaning a
  permissions-bypassed child that ignores SIGTERM. `forceKillAll()` sends SIGKILL to every
  active session's process group synchronously, no grace period — correct specifically
  because the bot process itself is about to disappear anyway.
- `startLiveSession` drains `child.stderr` (kept as a bounded 4000-char tail, same pattern as
  `delegate.ts`) and folds its tail into a crashed session's exit error. This isn't optional
  polish: an unread stderr pipe fills its OS buffer once the child (or a hook/plugin under it)
  writes enough to it, which then blocks the child on its next write — a session can hang
  silently while still showing as "active" if this is ever removed.
- `LiveSessionRegistry.teardown()`'s final flush retries a bounded number of times
  (`finalFlush`, 5 attempts / 500ms apart) before firing `onEnded` — the interval is already
  cleared and the session already removed from `byChannel` by the time teardown runs, so
  there's no later tick left to catch a transient Discord failure on the very last flush.
  Gives up gracefully (notice says output "may be incomplete") rather than retrying forever,
  since a genuinely broken sink (revoked token, deleted channel) must not hang teardown.
- `LiveSessionRegistry` now reserves the **project path**, not just the channel — the same
  cross-process file lock (`run-queue.ts`'s `reserveRun`/`releaseRun`/`updateReservationPid`,
  `~/.bean/runs/<hash>.json`) delegate runs (`RunRegistry`) already use. Before this fix, two
  different Discord channels (or a channel + a delegate run) targeting the same project could
  each spawn their own permissions-bypassed `claude` process into the same working directory
  concurrently. `LiveSessionRegistry`'s constructor now REQUIRES `{ dir }` (no default) —
  every test construction needs a temp `dir` (`mkdtempSync`, fresh per test/call, same
  convention as `chatops-runs.test.ts`), and both server.ts files pass their real `beanDir()`.
  Reservation is released in `teardown()` (only ever reached once the child is confirmed
  dead) — NOT in `forceKillAll()`, which deliberately leaves it in place, mirroring
  `RunRegistry.interruptAll()`'s exact reasoning (can't confirm the SIGKILL landed before the
  bot process exits; a future `reserveRun` pid-liveness-reclaims it once verifiably gone).
  `start()` returns the refusal reason (`"channel"` vs `"project"`) so the bot words them
  differently — saying "say `stop`" for a project another run holds is wrong advice.
  Live proposal ids are sequential (`live-<n>`): every claim (bot Start/Cancel) and every
  Discord picker/edit/mode mutation checks `conversationId` against the acting channel first,
  same as delegate cards.
  Gotcha if you write a test for this: don't use pid `1` as a fake "alive" pid — `isLive()`'s
  `process.kill(pid, 0)` throws `EPERM` (not `ESRCH`) for a system pid you can't signal, and
  the liveness check currently treats both the same way (dead), which silently defeats the
  reservation in tests. Use `process.pid` (the test process itself) instead.
- `bot.ts`'s live-session capture block advances `deps.conversations.setAmbientCutoff(...)` to
  `Date.now()` on every captured message (including `stop`) — without this, the ambient-chatter
  fetch (`fetchRecent`'s 15-min window, keyed off that same cutoff) would re-pull those same
  already-captured messages from Discord history after the session ends and hand them to
  `converse()` a second time as duplicate ambient context.
- `startLiveSession`'s `close` handler distinguishes an external signal kill (operator `kill
  -9`, an OOM reaper) from our own `stop()`/idle-timeout path: Node reports both as `code:
  null`, so only the `stopping` flag tells them apart — check it explicitly rather than
  treating every `code === null` as a clean end, or a session someone else killed gets
  reported as "ended" instead of "died".
- **Teams surface parity** (`teams/server.ts`): mirrors Discord's wiring — `liveSessions` /
  `liveSessionProposals` are hoisted (not inline in deps) so the `/api/messages` handler can
  `has()`-check to **capture** every message in a bound conversation (forwarded to `onMessage`
  even without an @mention — the bound session is its own auth boundary, same as Discord), and
  the SIGTERM handler can `forceKillAll()` the permissions-bypassed children. `mentionIds(a)`
  (mention entities minus the bot's own id) is passed as `mentionedIds` so `+driver`/`-driver`
  works. Group-channel capture still needs the manifest RSC permission `ChannelMessage.Read.Group`
  (same constraint as ambient); 1:1 chats are always addressed so it's moot there.
- Manual end-to-end smoke test (real Discord bot + real `claude` CLI) was not run as part of
  the implementation — it needs live Discord credentials and a test server that weren't
  available in the implementing session. Full monorepo test/typecheck gate is green; the
  interactive loop (proposal card → start → streaming → steer with a non-allowlisted user →
  stop → crash-path → bot restart while a session is active) still needs a human to drive
  once against a real bot.
- **Continue live (#234)**: a finished Claude delegate (Discord/Teams) can reopen as a live
  session — the finished card's `Continue live` button (`bean:resume-live:<id>` / Teams
  `beanAction: "resume-live"`, id in the `proposalId` slot) or `/live-session resume <id>`.
  `findDelegateRun()` (`delegate-runs.ts`) is the only source of the project path — never a card
  submit or picker (`LiveSessionProposalStore.update` and the Start handler drop `projectPath`
  for a `resume` proposal), and Start re-checks the row. A resumed Start needs a real starter id
  (no restricted→open fallback). claude rejects a bad `--resume` id with an error `result` event
  and exit 1 **before** `system/init`: `startLiveSession` ignores pre-init `result`s on a resume
  and reports `RESUME_REJECTED`, never a fresh session. The id doesn't change, so the ended card
  re-offers the button and nothing new is recorded.
- **Codex engine (#233)**: `core/codex-live-session.ts`, a second `LiveSessionHandle` picked by
  `cli` (registry's default StartFn dispatches; tests inject one fake and read `req.cli`). Codex
  has no multi-turn stdin, so it is **one `codex exec [resume <thread>]` spawn per turn**
  (`codexExecArgs`, shared with `delegateCommand`; no FAILED sentinel). Load-bearing rules:
  - Next turn spawns only after the previous child's `close`; mid-turn messages merge into one
    next turn, capped at 4000 chars — `send` returns false past that and the bot replies
    `CODEX_QUEUE_FULL` without appending to history.
  - Stop = **SIGINT** (then SIGKILL after 5s), not SIGTERM: codex runs tool commands in their own
    process group and only SIGINT stops them (#237). `stopping` is checked first on close because
    a SIGINT exit is code 1. `forceKillAll` still SIGKILLs (known orphan risk until #237).
  - **Reservation stays on the bot pid** for the whole codex session (registry skips
    `updateReservationPid`); per-turn pid swapping races the single-pid liveness check. Accepted
    ceiling: a bot hard-crash mid-turn frees the project while that turn finishes. `pid` is a getter
    for the current turn's child so `forceKillAll` reaches it.
  - **Codex resume ids must be UUIDs**: codex treats a non-UUID as a thread *name* and silently
    starts a new thread. Checked in `findDelegateRun`, the receipt button, and before spawn; the
    emitted `thread.started.thread_id` is compared too (mismatch → stopped, `CODEX_THREAD_MISMATCH`).
    "no rollout found" on resumed turn 1 → `RESUME_REJECTED`; never a fresh fallback (unlike runDelegate).
  - A failed later turn (`turn.failed`/error/non-zero exit) shows `— turn failed: …`, skips history,
    and the session stays bound; a turn 1 that never got `thread.started` ends the session.
  - The CLI is frozen from the `delegate_runs` row on a resume (`resume.cli`), re-checked at Start;
    an undetected CLI refuses ("codex isn't installed…") — another CLI never substitutes. A live
    model is kept only if that CLI's `clis.json` list offers it, else the CLI's own default.
