# project — Home's model history on the main log (#997)

Part of the one-conversation epic (#995). **Dark until the cutover marker** (`memory_meta` key
`mainConversationCutoverAt`, `mainCutover()`; written by #999 with the fold of the old histories).
Without it every path below is skipped and Home runs on renderer history (#975) exactly as before.

- **Log:** `chatops_turns` under `MAIN_CONVERSATION_ID` ("main"), the same `ConversationStore` the
  bots use (cross-process safe since #996). Bounded **before** each desktop turn with the desktop budget
  (`compactHistory`: >60 turns or >200 KB → summary + 20-turn tail), the summary swapped into the log
  by `replaceOldest` (CAS) — a turn-count-only pass after the reply let large posts overflow the
  model's context. No renderer `summary` item for Home on the log.
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
- **Known gap (deferred P2):** a card left pending is expired by the restore, but restored keys count
  as acked, so the log keeps its `pending` line.
- Wire: `CONTRACT_VERSION` 4 (`delta` in both chat guards, `turns` in the save guard).
