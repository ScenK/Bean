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
id is never re-attachable (release also `stopMount`s its live session). Live sessions are per chat (#517). A late memory receipt for a
released mount never lands in the chat now shown: the shell maps evicted mount → thread and holds it
until that thread is restored (then it's a live row with Undo, saved), or shows it at once if that
thread is already back on screen. Held per window lifetime only.

**Main — `buildChatThreadHandlers` (`ipc.ts`).** Sender must be the chat window (`isChatSender`), the id
a UUID, the payload ≤ 2 MB, and one chat (mount) writes one thread (pinned by its first save or its
restore) that no other open chat may save, restore (`chatThreadGet`) or delete.
The **sticky unsavable latch** is per mount: incognito toggle-on sets it *before* deleting the row, every
write (the final close write too) re-checks it, and toggling incognito off never clears it. A fetched
thread that's gone (deleted/pruned) restores as `{ missing: true }` → empty chat + status row.

**Renderer — `ChatSession.tsx`.** Thread id on the first composer input (agent mode included). Saves at
most 1 s after a change (`THREAD_SAVE_MS`, max-wait, not reset), immediately on a Bean reply, a live
`turn`/`ended`, and a delegate's terminal event; writes are serialized and skipped when the normalized
snapshot is unchanged. **The restored snapshot is the baseline** — viewing a chat never writes, so it
never bumps `updated_at` or resets its prune clock. `closeNow` awaits a final save before
`allowChatClose`, and sends `rememberOnClose` only when something was typed since load. `saveThread`
resolves to whether the snapshot landed (never rejects) — the switch-away save needs the answer. The linked-note
chip returns only if the slug still exists; a restored chat opens in Bean mode.

**History sidebar + in-place switch (#505, #516, #517) — `ChatWindow.tsx` (shell), `ChatSidebar.tsx`.** The
shell owns the sidebar, CLI availability, the dropped URL, the window-close card, and every
`window.bean.on*` listener — the preload bridges can't unsubscribe, so they're registered once and
routed through the `sessions` registry (mount id → `ChatSessionApi`, set each render, deleted at
unmount): delegate/live events and memory/image pushes by their `mountId` tag (untagged = the shown
chat), Plan-popup prompts and notices to the shown chat. A pick or New chat never closes the window.
The chat left behind **stays mounted, hidden** (`ChatPanel hidden` → `[hidden]` CSS) while it has work
(`hasWork`: a Bean request in flight or queued, a delegate starting/running, a live session), so its
loopback runs there at once; otherwise it **evicts** — final save (a failed save keeps it mounted with
an error row), `rememberOnClose`, then the shell drops it and its unmount `chatRelease`s it (same IPC
pipe, so main sees remember first). A pick another mount already holds is just shown; otherwise it
mounts fresh and restores via `chatThreadGet`. Every switch `sweep`s the other hidden chats: an idle
one evicts itself (a failed save silently stays for the next switch; re-shown meanwhile = stays).
**Off-the-record** chats are discarded on leave (`rememberOnClose` with incognito, then release); with
a running task the Keep/Stop card asks first ("Leaving discards this chat and stops its task.").
**Window close** = one shell card over every chat's `tasks()` (`closeCard`: single-chat wording, else
"Closing stops N tasks in M chats."); Stop & close `stopTasks` everywhere, then every chat `closeOut`s
(save + remember) before `allowChatClose`; main's `closed` stops everything anyway. Sidebar: a spinner
while a chat has work (`onWorking`, per mount → its thread), an unread dot when a reply or live turn
lands while hidden (`onUnread`), cleared when shown — held in the shell by thread, so it outlives
eviction. During an eviction save the composer is blocked (ChatPanel `busy`); work that began some
other way meanwhile keeps the chat mounted instead. New chat on an untouched empty chat does nothing;
an unused new chat never saves, so never gets a row. `busy` (sidebar disabled) = the shown chat's
eviction save only. Tests and e2e must scope queries to `.bean-chat:not([hidden])` — hidden chats are
in the DOM. The list loads on mount
and the active row follows the save ack (`withSaveAck`) — no push channel; listing's per-thread agents
come from SQL (`json_each`) so transcripts never cross IPC for the picker. Delete refuses a thread any
open chat holds, in main. Inline at ≥640px (collapse remembered in `localStorage`), overlay below
(always opens collapsed; Escape closes it via a layout effect — a passive effect missed a quick Escape
in e2e). e2e: match the chat window by `endsWith("/chat.html")`, not `includes("chat")` — a worktree
path like `.worktrees/516-chat-…` matches every window. `BEAN_E2E_EXECUTABLE` runs the specs against a
packaged `Bean.app` binary.

**Synced chats (#530) — `app/src/synced-chats.ts`, `SyncedChat.tsx`.** The owner's Discord/Teams
conversations (`chatops_conversations`, see `project-chatops-conversation-catalog.md`) merge into the
same Today/Earlier list (`mergeRows`, keyed `<surface>:<conversationId>` so they never collide with a
thread UUID) with a surface badge and kind chip, no ✕. A synced chat is a **view**, not a thread:
it never writes `desktop_chats`, has no incognito, no memory extraction, and its own attached mount.
Every list/get/send in main goes through the current owner's listing (`loadChatopsOwners` reads
`discord.json`/`teams.json` per call), so the renderer can only name a row the sidebar shows; get
and send also need an attached mount. Transcript mapping happens in main: the owner's `[Name]:`
prefix is dropped (a DM: always; elsewhere: the configured `ownerName`, which desk turns use —
the owner's own platform display name in a thread still shows), `[live session]` finals are the
last bound CLI's, the compaction summary is a status row, and stored context blocks (ambient,
replied-to) are left out. The view sits **over** the current desktop chat, which stays mounted
hidden — picking a desktop row/New chat goes back through that chat's `open()`; a dropped URL or
Plan-popup prompt shows it again. Main tracks running live sessions from the bots' `live`
activity (id = conversation id, cleared when a bot stops) and pushes `syncedChatEvent` (ids only)
on that and on `saved`; the shell re-lists, re-reads the shown one, and dots the others. A desk
turn shows as a pending bubble until a matching owner line lands; a refusal or a missing ack is an
error row (never resent). Composer: bot down → read-only, live → steer, after a session the
"Session ended — Continue live, or message Bean" placeholder (the Continue live button: see
project-live-sessions.md → Desk Continue live); 4,000-char counter (renderer copy of
`MAX_DESK_TEXT`, a test pins them equal).
