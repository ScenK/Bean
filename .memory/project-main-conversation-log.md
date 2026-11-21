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
- **No implicit delegate resume:** owner-DM delegates neither read nor write `thread_sessions`; the
  finished card's Continue live (`delegate_runs`) is the only resume. A bound live session doesn't
  reopen from text either: bare `continue` is a Bean turn, `/continue` posts the resume confirm card
  (`proposeResumeLive`) for the session last bound there — Start is the tap.
- `/new` in the owner DM answers a fixed line naming the persona, no reset. Desk sends to a `dm` row
  are refused `main-conversation`.
- **Outbox:** `appendDelivery` (core) maps a delivery only when it provably went to the owner's 1:1
  (Discord: no `userId` or the owner's, or a named destination that is the owner's DM channel; Teams: `ownerDmRefs` on the ref), under the existing
  `context` rule, keyed `delivery:<outbox id>` so a Teams fan-out to several owner DMs appends once.

## Cutover (#999)

- **Who/when:** core `runMainCutover`, called by the host each time it takes the scheduler lease
  (`startScheduler`) — the holder has the API key in remote setups. Marker present → no-op.
- **Fold:** Home's latest renderer `summary` (as the previous summary) + its user/reply/post items after
  it (cards skipped), and every live owner `dm` catalog row's turns (configured owner, `owner_alt_id`
  too), interleaved by time — undated Home items first in saved order. Summarized in ≤ 200 KB calls.
- **Commit:** one `BEGIN IMMEDIATE`: re-read the sources, and only if byte-identical to the fold's read,
  archive each owner DM's turns (`archiveTurns`, the `/new` archive form), write the summary as the
  log's first turn and the marker. A source written mid-fold → `changed`, nothing written; a failed
  summary call throws. Either way the **next boot** retries — no in-process retry.
- **Status entry:** the marker's value is the cutover time; #1000 renders it once.
- **Sidebar:** after the marker `listChatopsConversations` leaves out live owner-`dm` rows; their
  pre-cutover history lists as an archive (pruned like `/new` archives, 90 days).
