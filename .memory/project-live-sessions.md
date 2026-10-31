# Live sessions (chat-bridged interactive agent)

Chat-bridged multi-turn Claude Code, Codex or opencode sessions on Discord and Teams.

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
- **Four real concurrency bugs, now fixed** — all in the same class (async
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
  truncating the buffer until the corresponding send resolves.
  4. (#564) A turn boundary was a single `closeAfterFlush` boolean applied at the *next*
     flush, so next-turn output arriving before that tick (per-turn engines start the next
     turn synchronously; claude answers queued stdin right after `result`) was edited into
     the previous turn's message above the user's new one, and a turn ending mid-edit
     orphaned its footer as a separate message.
  Now `onTurnComplete` pushes `s.buf.length` onto `s.seals` (strictly increasing offsets, one
  per finished message) the moment the turn ends; `flushSession` re-reads `seals[0]` before
  every send. **Important asymmetry to preserve if you touch `flushSession` again**: `s.buf`
  for the unsealed tail is the message's full cumulative content and must NOT be truncated
  after an ordinary send — only rollover chunks and sealed segments ever leave it, always via
  `consumePrefix` *after* the send succeeds, which rebases every remaining seal by what was
  removed (output and seals can be appended during any await, so never rebase from a
  pre-await snapshot). `send()` deliberately does not seal: a mid-turn message's answer is
  the next turn.
- The stream sink rides `BotEffects`, preferring the optional **`postStream(text)→id` /
  `editStream(id,text)`** text effects, falling back to `postCard({content})` /
  `updateCard(id,{content})` when a surface omits them. Discord omits them — its `postCard`
  takes plain `MessageCreateOptions` so `{content}` already IS a text message. **Teams MUST
  supply `postStream`/`editStream`** (real `sendActivity({text})` / `updateActivity`), because
  its `postCard` wraps the arg as an adaptive-card attachment and `{content: text}` is not a
  valid AdaptiveCard — it would render broken. This is why Teams was originally hard-disabled;
  it is now **enabled** (`liveSessionsEnabled: () => clis().some(isLiveCli)`, same as Discord)
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
- Gating differs by surface. **Desktop** starts from the chat window over IPC (see the Desktop
  section below; its old `config.json` opt-in flag was dead and was deleted in #473). **Discord** has no config
  opt-in: `liveSessionsEnabled: () => clis().some(isLiveCli)` — always on when a live CLI is
  present, since the allowlist + the confirm-first card are the authorization boundary there.
  Launch is always confirm-first via a card even though the session itself runs with
  permissions bypassed once started.
- On both surfaces, owner/admin/guest roles (`chatops/roles.ts`) gate normal chat — but **an
  active live session in a channel is itself the authorization boundary for steering it**: any
  non-bot message in a capturing channel reaches the session's starter/co-driver/war-room check
  regardless of role (explicit decision). Every *launch* entry point (propose_live_session,
  `/live-session`, resume-live, Start, the Discord live-* card controls) is owner-only. Don't
  widen the launch gate to match the steering bypass.
- **Discord: a live session never binds a top-level channel (#533).** `live-session` is not in
  `KEYWORD_RE`, so a typed top-level `@Bean /live-session …` opens a thread like any mention; an
  owner's top-level slash pick creates a thread too (`channel.threads.create`, same two permissions,
  falling back to the channel). A channel-bound session would capture everyone's messages there.
- **Busy rule (#533):** while a session is bound, a `/live-session …` (start or resume) is never a
  steer — the owner gets "A <cli> session is already running here — `stop` it first.", anyone else
  is dropped; `proposeLiveSessionFrom` refuses the same way, so a slash pick posts no card.
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
- One live session per **channel**; sessions and delegate runs share a project freely (#385
  removed the per-project reservation — each agent works in its own worktree). Each session
  writes a run record (`run-queue.ts`'s `recordRun`/`releaseRun`/`updateRunPid`,
  `~/.bean/runs/<runId>.json`) for crash cleanup. `LiveSessionRegistry`'s constructor REQUIRES
  `{ dir }` (no default) — every test construction needs a temp `dir` (`mkdtempSync`, fresh per
  test/call), and both server.ts files pass their real `beanDir()`. The record is released in
  `teardown()` (only reached once the child is confirmed dead) — NOT in `forceKillAll()`, which
  leaves it for boot cleanup, mirroring `RunRegistry.interruptAll()`.
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
- **Lazy resume (#531)**: every Continue live (desktop, chatops card, `/live-session resume`) starts
  with `prompt: ""` — no synthetic opening turn (the old `RESUME_OPENING` is gone). Both engines
  then spawn **nothing until the first `send()`**, which becomes turn 1 (with the git trailer); the
  idle timer arms at start, and a stop/idle before any send ends clean with no spawn. A rejected id
  therefore fails *that first send* with `RESUME_REJECTED` ("Nothing was sent."). Consequences:
  claude's `pid` is a getter and is undefined until then, so both hosts move the run record to
  claude's child on the first send too (`trackPid`), not only at start; the resume card has no
  prompt or skill (nothing to frame); the channel gets no typing ping until someone types; the
  desktop composer isn't busy, and a rejection hands the unanswered text back to the composer
  (`LiveState.unopened`, refilled when the session fails before its `session` receipt).
- **Codex engine (#233)**: `core/codex-live-session.ts`, a second `LiveSessionHandle` picked by
  `cli` (registry's default StartFn dispatches; tests inject one fake and read `req.cli`). Codex
  has no multi-turn stdin, so it is **one `codex exec [resume <thread>]` spawn per turn**
  (`codexExecArgs`, shared with `delegateCommand`; no FAILED sentinel). Load-bearing rules:
  - Next turn spawns only after the previous child's `close`; mid-turn messages merge into one
    next turn, capped at 4000 chars — `send` returns false past that and the bot replies
    `CODEX_QUEUE_FULL` without appending to history.
  - Stop = **SIGINT** (then SIGKILL after 5s), not SIGTERM: codex runs tool commands in their own
    process group and only SIGINT stops them (#237). `stopping` is checked first on close because
    a SIGINT exit is code 1. `forceKillAll` SIGKILLs each child's whole process tree (`killTree`, #246), not just its group.
  - **The run record stays on the bot pid** for the whole codex session (registry skips
    `updateRunPid`); a dead between-turns child's pid would get swept. Accepted ceiling: boot
    cleanup misses a turn still running after a bot hard-crash. `pid` is a getter for the current
    turn's child so `forceKillAll` reaches it.
  - **Codex resume ids must be UUIDs**: codex treats a non-UUID as a thread *name* and silently
    starts a new thread. Checked in `findDelegateRun`, the receipt button, and before spawn; the
    emitted `thread.started.thread_id` is compared too (mismatch → stopped, `CODEX_THREAD_MISMATCH`).
    "no rollout found" on resumed turn 1 → `RESUME_REJECTED`; never a fresh fallback (unlike runDelegate).
  - A failed later turn (`turn.failed`/error/non-zero exit) shows `— turn failed: …`, skips history,
    and the session stays bound; a turn 1 that never got `thread.started` ends the session.
  - The CLI is frozen from the `delegate_runs` row on a resume (`resume.cli`), re-checked at Start;
    an undetected CLI refuses ("codex isn't installed…") — another CLI never substitutes. A live
    model is kept only if that CLI's `clis.json` list offers it, else the CLI's own default.
- **Shared per-turn engine (#238)**: codex and opencode both run `core/turn-live-session.ts`
  `startTurnLiveSession(adapter, …)`; each CLI is a small `TurnAdapter` (`codexTurnAdapter`,
  `opencodeTurnAdapter`) — argv, event parse → `{sessionId, completed, failure, result, tail}`,
  pre-spawn id check, resume-rejected stderr, mismatch notice, stop, end messages. The codex rules
  above (spawn after close, 4000-char merged queue `TURN_QUEUE_FULL`, bot-pid reservation, failed
  later turn stays bound, no fresh fallback) now hold for both. The registry dispatches by `cli`,
  moves the reservation to the child pid **only for claude**, and builds `VERBATIM_END` from the
  adapters' `endMessages`.
  - Spawn invariants for every per-turn CLI: stdin `ignore` (**opencode blocks forever on an open
    stdin pipe**), `detached`, env `PWD=projectPath` (opencode prefers an inherited `PWD` over the
    spawn cwd, #247).
  - Stop: codex SIGINTs its own group; opencode SIGTERMs every group of its tree (it reaps tools
    on neither signal). Both then `escalateKill` the snapshotted groups after 5s, deliberately not
    cancelled on close (#246). Unit tests that stop a session must mock `execFileSync` (the `ps`
    snapshot) and call `killPendingGroups()` while `process.kill` is still mocked.
  - opencode: turn done = `step_finish` with `part.reason: "stop"` (`"tool-calls"` means another
    step follows); `sessionID` on any non-`error` event proves the session; an `error` event's
    `error.data.message` can echo an API-key prefix, so only `name` + `statusCode` reach chat
    (401/403 → `OPENCODE_SIGNED_OUT`). Resume ids must be `ses_…` (`isLiveSessionId`, also gating
    `findDelegateRun` and the receipt button); a bad id fails fast with `Session not found`.
  - No first-event watchdog: provider stalls of 35–90s with no events are normal, and a tool is
    silent until it finishes, so the 30-min idle timer is the only ceiling.
  - Start refuses a `browser: true` skill on opencode (`OPENCODE_BROWSER_REFUSAL`) and a picked
    skill that's gone/disabled **before claiming the card**, so the user can re-pick on it.

## Desktop (#476, epic #472)

- `app/src/live-tasks.ts` `createLiveTasks` hosts desktop sessions over core's `startLiveEngine`
  — not `LiveSessionRegistry` (its 1900-char rollover, 1.5s throttle and co-drivers are
  Discord/multi-user shapes). Registry is keyed by **session id**; "one session per chat" is only a
  check in `start()`/`resume()` (owner `LiveOwner` = sender `webContents.id` + chat mount id, #517;
  IPC refuses an unattached mount). At most `LIVE_SESSION_CAP` (10) sessions at once across all chats
  — they run with permissions bypassed — counting pending starts and still-stopping ones; the cap
  refusal is `LIVE_CAP_REACHED`, shown as the chat's error row, and `canStart` gates the hand-off
  offer. Events carry `mountId` so a hidden chat still gets them; release `stopMount`s, window
  `closed` `stopOwner`s (by sender). The pending entry is registered **before** awaiting the project
  check, so a window close mid-startup (`stopOwner`) means the child is never spawned.
- Two spawns (`liveSpawnFn`): claude stdin `pipe` (stream-json turns), codex/opencode stdin
  `ignore`; both get the login-shell PATH, `PWD=cwd`, `spawnEnv`. Don't reuse delegate-tasks'
  `resolvedPathSpawnFn` for claude — its stdin is `ignore`.
- IPC `bean:live-start|send|stop` + push `bean:live-event` (`started`/`output`/`turn`/`ended`,
  each with `sessionId`, `agent`, per-session `seq`). Main checks the sender is the chat window,
  the CLI is enabled, the project is configured or `scratchDir`, and sizes (`ASK_LIMIT`).
- Handoff (`buildHandoff`, pure): last ≤20 user/reply items, ≤8k chars (≤2k per item), as `> `
  quoted context labeled non-instructions, then the ask; an oversized ask is rejected, never
  truncated; `count` is exactly what was sent. Memories/persona never go in.
- Lifecycle: chat window `closed` → `stopOwner`; `before-quit` → `forceKillAll()` (SIGKILL trees +
  `killPendingGroups`) beside `killAllDelegates()`, and the update install's `relaunch` hook too
  (`app.exit()` skips before-quit; a source test in `live-tasks.test.ts` guards both). No outbox notice: records stay for the next
  boot's silent `sweepDeadRuns`. Record pid moves to the child for claude only (chatops rule).
- Pet badge: desktop sessions are `TaskJob` `kind: "live"` + `agent`; `liveBadgeAgent` picks the
  newest running one and avatar.ts renders a 16px `AgentAvatar` in the orb slot's corner (visible in
  menu/drag modes). Chatops sessions stay `kind: "delegate"` (`chatops-activity.ts`) → no badge.
  The `.bean-agent-avatar--*` fill mappings live in `orb.css` because the avatar window doesn't
  load `shared.css`.
- Agent mode in the chat window (#477): `ChatWindow` holds `mode` (who answers) + one `LiveState`;
  pure pieces in `components/chat/agent-mode.ts`. Load-bearing rules:
  - **Routing by construction**: only `onComposerSend` (typed composer text) reaches
    `liveStart`/`liveSend`; loopbacks, skill prompts and Save to notes call `sendMessage`
    directly, so they stay Bean turns in agent mode. Don't route `sendMessage` by mode.
  - `chatTurns` is the one mapper for Bean's `history` and `closeTranscript`: agent finals are
    `[Claude Code] <result>` (≤4k) for Bean; with `memory: true` live steering (`source: "live"`)
    and agent finals are dropped entirely.
  - The renderer adopts a session id from the `started` event (or liveStart's result) only for
    its current start; events for any other id are ignored. A start ended before its id arrived
    is stopped once the id lands. `start()` ignores a *stopping* session in the one-per-window
    check, so a switch doesn't wait for the old process to exit.
  - Project: `""` = scratch (main maps it via `scratchPath`); the window's last used project
    (chip pick, confirmed delegate/terminal run) — never `projects[0]`.
- Hand-off offer (#478): desktop passes `liveSessionAvailable` per request **by sender + mount**
  (chat window, a live CLI enabled, `liveTasks.canStart(owner)`) plus `liveSessionHost: "desktop"`,
  which swaps in `proposeDesktopLiveSessionTool` (offer wording, no cli/model, project optional =
  `scratchPath`). The chatops channel tool and its tests are untouched. The renderer shows an
  `offer` item (`LiveOfferCard`); Start = `startOffer` → the same `startSession` handoff as
  `/claude <ask>` with the model's instruction as the ask, engine = `offerAgent(clis)` (claude
  first), claimed once via `offersClaimedRef`; an unknown project path (core's scratch) maps to
  `""`. Wording edits: re-run `converse-live-offer.live.test.ts`.
- Continue live (#479): a desktop `DelegateReceipt` carries `sessionId` + `agent` only when the CLI
  is live-capable with its id shape (`isLiveSessionId`). The card's button (`canContinueLive`:
  receipt + CLI enabled + no live session in the window) sends **only the id** over
  `bean:live-resume`; `liveTasks.resume` reads CLI + project from the newest row via
  `findDelegateRun(…, "desktop")` (desktop rows only; chatops' default still refuses them), opens
  lazily on the first send (no opening turn, no handoff), and refuses an id already live in any window (claim lasts
  while the session lives). The CLI is frozen; a rejected id ends `RESUME_REJECTED`, never fresh.
- Live sessions resume too (#503): `LiveSessionCallbacks.onSessionId` (optional, errors swallowed;
  chatops ignores it) fires once per engine — claude on `system/init`, per-turn CLIs on the first
  accepted session event — and never on a rejected or mismatched resume. `live-tasks` checks
  `isLiveSessionId`, records a desktop `delegate_runs` row (fresh only), claims the CLI id like
  `resumeId` (`cliId`, so a still-stopping child can't get a second writer), and emits `session`
  (`LiveReceipt`, kept on `LiveState`). The ended/failed row, and End/switch/close's row, carry it as
  a `status` receipt → Continue live; End's row is `exiting` (button disabled) until that session's
  `ended` event. `LiveEvent.sessionId` stays Bean's own id.
- **Desk Continue live (#532)**: app→bot `desk-resume {requestId, conversationId}` only (same
  `desk-ack` contract as a desk turn). `bot.onDeskResume` re-derives everything: the catalog row's
  `live_cli`/`live_session_id` and `findDelegateRun` must agree on surface (`catalog.surface`), CLI and
  session, else `no-record` — a row with no recorded id never starts fresh. Then owner-now
  (`not-eligible`), `channel-busy` (a running session, or another desk resume for the conversation
  mid-await — a phone-side reopen racing it gets the registry's one-per-channel `"channel"` →
  `channel-busy` too), `cli-missing`. It runs the same `startLiveSessionAction` as a card Start
  (shared `resumeRefusal`), with no card, `quiet` (refusals are only acked, never posted), restricted,
  `starterId` = the catalog's `owner_id`; the mode line still posts so the phone sees it reopen. The
  synced chat's button (`listing.resumable` = an id is recorded; the id never crosses IPC) shows
  "Opening…" until the bot's `live start` makes the row live (hidden while live) or a refusal row.
- Desk turns (#528) into a conversation with a running live session are plain steers (same
  `steerLive` path as typed text, starter/co-driver check against the catalog's owner id) —
  never keyword commands like `stop`/`+driver`; see project-teams-bot.md → Desk ingress.
