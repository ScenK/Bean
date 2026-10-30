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

**Chat mounts (#515) — `buildChatMounts` (`ipc.ts`).** Main keys per-chat state by a **mount id** (a
renderer-made UUID per chat session, `chatAttach`/`chatRelease`), not by webContents id, so one window
can hold several chats. Every per-chat request (chat, thread save/get/pending, incognito, remember on
close, delegate start) carries the mount id as its trailing arg and is refused unless it's the chat
window and that mount is attached to it; the memory receipt and image progress pushes carry it back
(the renderer drops other mounts'). Release (or the window's `closed` → `releaseChatSender`) drops
the mount's thread pin/latch and memory state and cancels its delegates (`cancelMount`); a released
id is never re-attachable. Live sessions are still per window (#517).

**Main — `buildChatThreadHandlers` (`ipc.ts`).** Sender must be the chat window (`isChatSender`), the id
a UUID, the payload ≤ 2 MB, and one chat (mount) writes one thread (pinned by its first save or its
restore) that no other open chat may save, restore (`chatThreadGet`) or delete.
The **sticky unsavable latch** is per mount: incognito toggle-on sets it *before* deleting the row, every
write (the final close write too) re-checks it, and toggling incognito off never clears it. A pending
or fetched thread that's gone (deleted/pruned) restores as `{ missing: true }` → empty chat + status row.
The window pulls the pending thread once on mount.

**Renderer — `ChatWindow.tsx`.** Thread id on the first composer input (agent mode included). Saves at
most 1 s after a change (`THREAD_SAVE_MS`, max-wait, not reset), immediately on a Bean reply, a live
`turn`/`ended`, and a delegate's terminal event; writes are serialized and skipped when the normalized
snapshot is unchanged. **The restored snapshot is the baseline** — viewing a chat never writes, so it
never bumps `updated_at` or resets its prune clock. `closeNow` awaits a final save before
`allowChatClose`, and sends `rememberOnClose` only when something was typed since load. The linked-note
chip returns only if the slug still exists; a restored chat opens in Bean mode.

**History sidebar (#505) — `ChatSidebar.tsx`, `ChatWindow.tsx`.** A pick never swaps transcripts in
place: `chatThreadOpen(id | "new")` stores the target in main (`requestSwitch`) and closes the chat
window the normal way, so the Keep/Stop card ("Switching chats stops…", `Stop & switch`), the final
save and close-time memory all still run. Keep working sends `chatThreadOpen(null)` to clear the
target — otherwise a later plain close would switch. At `closed`, `takeSwitch` makes the target the
pending thread and main opens the next chat window at the old window's exact bounds (captured at
the real close; the window is gone by `closed`). The list loads on mount and the active row follows
the save ack (`withSaveAck`) — no push channel; listing's per-thread agents come from SQL
(`json_each`) so transcripts never cross IPC for the picker. Delete refuses a thread any
open chat holds, in main. Inline at ≥640px (collapse remembered in `localStorage`), overlay below (always opens
collapsed; Escape closes it via a layout effect — a passive effect missed a quick Escape in e2e).
