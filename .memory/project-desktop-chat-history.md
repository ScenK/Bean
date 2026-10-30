# Desktop chat history (save + restore)

Every non-incognito desktop chat is written through to `bean.db`'s `desktop_chats` (core
`desktop-chats.ts`, 90-day prune inside `listDesktopChats`). Epic #501; this entry covers the save/restore
slice.

**Normalizer — `renderer/components/chat/chat-thread.ts`, node-free, runs on every save and again on
restore.** Never mutates. Drops `working` items, `reply.session`/`tail`/`streaming` (a streaming reply
gets the "— turn interrupted" footer), delegate `taskId`/`tail`, status `exiting`, and every image data
URL (user/reply images → `[image attached]` appended to the text once; note-card images dropped). Pending
proposal/delegate/note/skill/todo/offer cards become `expired`, starting/running delegates
`interrupted`, memory rows `kept` (no Undo). Delegate and live-status **receipts are kept** — Continue
live resumes through main's `findDelegateRun(…, "desktop")`, never through restored JSON. Each text is
capped at 20k chars, the list at 500 items (oldest dropped), the JSON at 2 MB (renderer copy of
`DESKTOP_CHAT_MAX_BYTES`). `restoreItems` remaps every id with `newId()` (a restored `item-3` would
collide with the new load's counter) and drops `source` from user turns, so restored turns are context
only for memory extraction. A restored done delegate has no `taskId`, so no event can loop it back.

**Main — `buildChatThreadHandlers` (`ipc.ts`).** Sender must be the chat window (`isChatSender`), the id
a UUID, the payload ≤ 2 MB, and one window writes one thread (pinned by its first save or its restore).
The **sticky unsavable latch** is per window: incognito toggle-on sets it *before* deleting the row, every
write (the final close write too) re-checks it, and toggling incognito off never clears it. A pending
thread that's gone (deleted/pruned) restores as `{ missing: true }` → empty chat + status row.
`setPending` is main's hook for the history sidebar (#505); the window pulls it once on mount.

**Renderer — `ChatWindow.tsx`.** Thread id on the first composer input (agent mode included). Saves at
most 1 s after a change (`THREAD_SAVE_MS`, max-wait, not reset), immediately on a Bean reply, a live
`turn`/`ended`, and a delegate's terminal event; writes are serialized and skipped when the normalized
snapshot is unchanged. **The restored snapshot is the baseline** — viewing a chat never writes, so it
never bumps `updated_at` or resets its prune clock. `closeNow` awaits a final save before
`allowChatClose`, and sends `rememberOnClose` only when something was typed since load. The linked-note
chip returns only if the slug still exists; a restored chat opens in Bean mode.
