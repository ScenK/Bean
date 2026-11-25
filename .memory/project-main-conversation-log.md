# project — Home's and the owner DMs' model history on the main log (#997, #998)

Part of the one-conversation epic (#995). **Dark until the cutover marker** (`memory_meta` key
`mainConversationCutoverAt`, `mainCutover()`; written by #999 with the fold of the old histories — see Cutover below).
Without it every path below is skipped and Home runs on renderer history (#975) exactly as before.

- **Log:** `chatops_turns` under `MAIN_CONVERSATION_ID` ("main"), the same `ConversationStore` the
  bots use (cross-process safe since #996). Bounded **before** each desktop turn with the desktop budget
  (`compactHistory`: >60 turns or >200 KB → summary + 20-turn tail), the summary swapped into the log
  by `replaceOldest` (CAS) — a turn-count-only pass after the reply let large posts overflow the
  model's context. The log's leading summary row (`formatSummaryBlock` prefix) rides as the
  *previous* summary and is replaced with the turns — as a turn it was clipped to 2,000 chars. No renderer `summary` item for Home on the log.
- **Who is "main":** the host decides — the chat (mount) pinned to `HOME_THREAD_ID` while the marker
  exists (`threads.isMain`). The shell learns it from `chatThreadGet("home")` → `home.log`.
- **Keys = dedupe:** every desktop turn rides with a `turn_key` (`desktop:<key>`): a user turn or reply
  by its item id, a card by `id:<record line>` (each state one more line). The host appends Bean's
  own turn (`desktop:<turnId>`) and reply (`desktop:<turnId>:reply`) after `converse()`; the renderer
  acks the reply item's id. A lost ack only re-sends. Restored items count as acked (the save that
  kept them flushed them).
- **Flush:** `chat` carries `delta`, `chatThreadSave` carries `turns` — so card outcomes and live
  finals land on save/close without a next model turn. Posts never ride: the drain
  (`saveDesktopChatDraining(…, { mainLog })`) appends each in the same transaction as `post:<id>` —
  only posts that save actually drains, so a replay after compaction can't re-add one.
- **Gap marker:** host-side from the log's newest `created_at`, read before the delta lands;
  `req.gap` is ignored on the log.
- **Item ids** (`newId`) carry a per-load random segment: keys live in the log for good, so a reopened
  chat's ids must never repeat an earlier load's.
- **Continue in Discord** is refused for the main conversation (ipc.ts; the button is disabled) — use a
  task chat. A pre-cutover `continued` pointer is dropped when Home restores on the log.
- **Over SSH:** `chatThreadGet`/`chatThreadSave` are `REMOTE_OPS` (mount-checked by the host's chat
  sessions), so a remote shell opens Home, gets `home.log` and flushes `turns`; the thread list stays local.
  A remote save keeps the stored note link (`keepNote`): there's no `listNotes` over SSH, so the
  shell's save would unlink it.
- **Known gap (deferred P2):** a card left pending is expired by the restore, but restored keys count
  as acked, so the log keeps its `pending` line.
- Wire: `CONTRACT_VERSION` 4 (`delta` in both chat guards, `turns` in the save guard).

## Owner DMs (#998)

- **Gate:** `historyId()` in `chatops/bot.ts` — marker present (`deps.mainLog.cutover()`, wired in
  `sharedBotDeps`) **and** the conversation's catalog row is a `dm` whose owner `roleOf` still calls the
  owner (Teams `29:`/AAD aliases through roleOf). In `onMessage` the speaker must also be the owner in a
  `direct` message, checked before the history read. Fail closed: no catalog/row/marker, a member's DM, a
  channel, a changed owner → the real id. Only history maps; cards, runs, reminders, live bindings and
  catalog rows keep the real DM id. Appends carry `surface` (discord/teams).
- **Bounded before each turn** with the desktop budget (core `boundMainLog`, shared with the host) —
  never `maybeCompact`, which clips the log's summary row like a turn.
- **No implicit delegate resume:** owner-DM delegates neither read nor write `thread_sessions`; a
  card always starts fresh. The resumes are the task grant's cardless continuation (#1114, keyed
  by the real DM id, never `main` — [convention-delegate-task-grant](convention-delegate-task-grant.md))
  and the finished card's Continue live (`delegate_runs`). A bound live session doesn't
  reopen from text either: bare `continue` is a Bean turn, `/continue` posts the resume confirm card
  (`proposeResumeLive`) for the session last bound there — Start is the tap.
- `/new` in the owner DM answers a fixed line naming the persona, no reset. Desk sends to a `dm` row
  are refused `main-conversation`.
- **Outbox:** `appendDelivery` (core) maps a delivery only when it provably went to the owner's 1:1
  (Discord: no `userId` or the owner's, or a named destination that is the owner's DM channel; Teams: `ownerDmRefs` on the ref), under the existing
  `context` rule, keyed `delivery:<outbox id>` so a Teams fan-out to several owner DMs appends once. A Home post's phone copy
  (#1067, `OutboxMessage.mainTurnKey`) is keyed `post:<id>` instead, so it and the drain dedupe.

## Cutover (#999)

- **Who/when:** core `runMainCutover`, called by the host each time it takes the scheduler lease
  (`startScheduler`) — the holder has the API key in remote setups. Marker present → no-op.
- **Fold:** Home's latest renderer `summary` (as the previous summary) + its user/reply/post items and
  card records (`cardRecord`, a loose copy of the renderer's `cardItemRecord`) after it, and every live owner `dm` catalog row's turns (configured owner, `owner_alt_id`
  too), interleaved by time — undated Home items first in saved order. Summarized in ≤ 200 KB calls.
- **Commit:** one `BEGIN IMMEDIATE`: re-read the sources, and only if byte-identical to the fold's read,
  archive each owner DM's turns (`archiveTurns`, the `/new` archive form, dated at the cutover so a
  long-quiet DM's archive isn't pruned on the next listing), write the summary as the
  log's first turn and the marker. A source written mid-fold → `changed`, nothing written; a failed
  summary call throws. Either way the **next boot** retries — no in-process retry.
- **Home open = defer:** the commit is skipped (`changed`) while any chat holds Home (`inUse`, the
  host's `holderOf(HOME_THREAD_ID)`): a Home restored before the marker runs on the shell's history
  until reopened, so its later turns would never reach the log. No restore wait or send gate — the next
  boot retries (a standby host taking the lease later is covered the same way). Known gap: an owner-DM
  turn in flight at the commit appends to its legacy id (deferred P2).
- **Status entry:** the marker's value is the cutover time; #1000 renders it once.
- **Sidebar:** after the marker `listChatopsConversations` leaves out live owner-`dm` rows; their
  pre-cutover history lists as an archive (pruned like `/new` archives, 90 days).

## Desktop shows the owner's DM exchanges (#1000)

- **Read:** core `mainSince(file, cursor)` — `discord`/`teams` entries past the cursor only (never
  `desktop`, posts or summaries: no surface), mapped by the shared `mapSyncedTurn` (moved from the app to
  core `chatops/transcript.ts`). Seqs only grow, so `newest - cursor > rows past it` = compaction took
  some → `trimmed` → the shell's existing trim notice. Capped at 200 rows per pull.
- **Host:** `threads.mainSince` serves only the chat holding Home on the log; `chatMainSince` is a
  `REMOTE_OPS` entry (generation-checked like every op). The cutover line (persona's name) rides the
  first pull with a DM or summary past the cursor and no DM at or before it — desktop turns moving the
  cursor first don't cost it; a fresh install gets none until its first DM. The shell dedupes it by text.
  Rows are counted in SQL and only the newest 200 DM bodies read. Wire: `CONTRACT_VERSION` 5 (a v4 core
  refuses the pull, so the shell must see a mismatch rather than connect and silently show nothing).
- **Cursor:** kept host-side in `memory_meta` (`mainConversationHomeCursor`), written by a Home save
  carrying `mainCursor` *after* the items land; `chatThreadGet("home")` returns it as `home.cursor`.
  A lost write only re-pulls; the renderer dedupes `dm` items by `seq`.
- **Ping:** a bot's `saved` for `MAIN_CONVERSATION_ID` is swallowed by the host (not a sidebar row) and
  becomes a text-free mount push `main` (payload = the mount id) to Home's holder — over SSH too. Replay
  evicts old `main` pings like output lines (any later pull covers them); the shell also pulls on every
  remote (re)attach — first re-opening Home (`chatThreadGet("home")`), since a restarted core lost the
  chat's thread pin and refuses the pull without it — since a ping acked just before a drop never replays.
- **Renderer:** `dm` items (`applyMainPull`): pulled on show, focus, the ping and each Bean turn's end
  (deferred while one runs). Inert, labelled "via Discord/Teams", never in `chatTurns`/`keyedTurns`
  (so not in the delta or close-time memory), no unread mark.
