# Bean's memory subsystem

`~/.bean/bean.db` (SQLite, `core/src/db.ts`) holds a curated `Memory[]` (`{ id, text,
projectPath?, createdAt }`, `core/src/memory/memory.ts`) in a `memories` table + `memories_fts`
FTS5 index. Global entries have no `projectPath`; project ones carry a registered project's path
(model-tagged during extraction, enum-constrained so it can't be invented). As of the SQLite
migration (see [[safety-memory-append-vs-replace]]), the old `~/.bean/memory.json` /
`~/.bean/notes/*.md` files are imported once on first `openDb()` call and then left untouched —
see `db.ts`'s `migrateFromFiles`.

- **Automatic, no confirm card (#177):** closing the chat window is instant — the renderer sends
  `rememberOnClose(transcript, { incognito })` fire-and-forget and calls `allowChatClose` (the
  `reviewBeforeClose` intercept survives only for the running-delegates Keep/Stop prompt).
  **A quit is a close too (#862):** `before-quit` cancels the first quit while the chat window
  closes. Local core: `reviewBeforeClose(true)` = close with no Keep/Stop card (quit stops the
  work), then the exit waits for `memory.settled()` (in-flight captures + catch-ups; capped at
  `QUIT_MEMORY_WAIT_MS`) — the extraction runs in-process and would die with it. Host `onQuit`
  teardown and terminal kills run once (`onQuitTeardown`) — on a local quit *before* the
  chat closes: its close cleanup SIGTERMs live agents and drops their sessions, so a later SIGKILL
  of their trees would miss tools in their own process groups and orphan them. The host
  (`buildMemoryHandlers` in `host/src/memory.ts`) runs `extractMemories` → `appendMemories` and keeps the id
  batch in memory; a non-empty batch shows a `kind: "memory"` avatar bubble whose click opens
  Persona (never undoes — its old click meaning was dismiss). Persona's **Just remembered · Undo**
  deletes exactly that batch's ids; the Undo window lasts until the next batch or app restart.
  A one-shot `auto-memory-notice.json` flag (userData) makes the first bubble explain itself.
  A broken save (`failed`, or any load/store rejection) raises a sticky `memory:error` bubble
  ("Couldn't update memory") via `onMemoryFailure`; nothing worth saving shows no bubble. Logs
  carry the rejected *count* only, never fact text.
- **Episodes, not per-turn capture:** see [[project-episode-memory]] — a chat quiet for 10 min
  (or switched away from / closed) gets one synthesis pass over the whole exchange; `memory.ts`
  tracks, per chat (mount id), the turn ids already covered, the saved ids (pending for dream
  until the window closes), the live 🕶 chip (re-checked before the model call and the insert)
  and a queue so a close waits for an idle episode in flight. Config `autoMemory` (default true;
  Settings → Memory) off = explicit remember/forget only. The per-window `🕶` chip makes a chat
  write nothing.
- **Trust boundary:** `ChatTurn.source` is recorded when a turn arrives; an episode needs at
  least one new `role: "user"` + `source: "typed"` turn (`isCitable`) or no model call is made —
  a delegate loopback, a composed skill prompt or a compaction summary alone starts nothing.
  What a memory says is no longer matched against the typed words ([[project-episode-memory]]);
  `extractMemories` returns `{ candidates, rejected, failed }`. The recall block frames memories
  as data and tags them `[id]`.
- **Explicit remember/forget:** `makeMemoryTools()` → direct `remember` + `forget_memory` action
  tools, offered only on a typed turn (`ChatRequest.source === "typed"` on desktop), authorized
  in `run()` by a typed-text-only intent classifier. Desktop shows a `🧠 Remembered — …` status
  line; chatops posts a Forget card (see [[project-chatops-memory-flow]]). A forget turn is marked
  handled in `captureTurn` and its `ConverseResult.forgotten` texts join the renderer's
  `rejectedMemoriesRef`, so close catch-up never re-saves what was just forgotten. Each
  forgotten row also gets a `kind: "forgot"` receipt (`🧠 Forgot — … · Undo`, class
  `bean-status--forgot`): Undo re-appends the full deleted row via `memory.append` (same id, so
  a plain INSERT — an id that exists again is a visible, retryable error), marks it `restored`
  only after the append lands, and drops its text from `rejectedMemoriesRef`. History keeps only
  the receipt's text (`kept`, no Undo) — never the row snapshot.
- **Category at capture (#648):** the remember tool spec always offers an optional English
  `category` (byte-stable); the existing category list rides as framed user-role data
  (`categoriesBlock` — next to `existingBlock` in extraction, appended to converse's recall via
  `memoryCategories`), never the spec or a system message. Only owner paths keep it: desktop
  extraction + remember (`categorize: true`), owner-DM `captureDm` + remember. Member DMs,
  channels and channel capture drop whatever the model gave. Quote validation covers `text`
  only, so a Chinese fact with an English category passes; `sanitizeCategory` normalizes it.
- **Context label (#856, legacy):** `memories.context` is no longer written — episode text is
  self-contained. Old rows keep theirs: recall renders `[re: <context>] <text>` and dream's
  `borrowsContext` rule still applies to them.
- **Capture bar (owner ask, 2026-11-18, replaces "generous"):** one question — would it change
  how Bean helps next week? See [[project-episode-memory]]. Agent-mode steering the user typed
  counts as typed at close (`chatTurns` maps `live` → `typed`, a composed `/skill` prompt →
  `skill`; agent finals ride as ≤1k context).
- **Recall:** `converse()` ranks via `selectRelevantMemories()` — up to 40 memories inject all;
  above, an FTS5 bm25 top-30 against the latest user message.
- **"You" is the only reserved category (#650, `OWNER_CATEGORY`):** on owner paths only — desktop
  `buildChatHandler` and the owner's chatops DM (`pinOwnerMemories`) — the newest 15 rows with
  category exactly `You` are pinned ahead of the top-30 (outside it). Channels, member DMs,
  chime-ins and routines never pin. Pinned rows ride the same user-role recall message; the
  system message is untouched (cache-stable).
- **Enabled-skills filter** lives in `buildChatHandler` (host `chat.ts`), not in `converse()`.
- **Edit surface:** Persona's MEMORY section, per-row `updateMemory`/`updateMemoryCategory`/
  `deleteMemories`/`appendMemories` (+ one-statement `renameMemoryCategory`) only — see
  [[safety-memory-append-vs-replace]]. Sections come from core's renderer-safe
  `@bean/core/memory` `memorySections()` (#651): You ("N of `OWNER_PIN_LIMIT`" always on, older
  You rows dimmed) → categories A–Z → Uncategorized → Channels (per `sourceId`) → Others (non-owner
  🔒 rows + legacy uncategorized `Name:` rows) → Projects. Under 8 owner rows it's one flat list.
  Only owner rows get the category input — a category on a channel/member row would join recall pinning.
- **Dream (background consolidation, #177 PR 2):** `memory/dream.ts` `maybeDream()` is checked
  after each desktop auto-save (close batch or per-turn capture; no timer, no boot cost). Due when ≥24h
  since `lastDreamAt` **and** ≥5 memories created since (a `created_at` count — no counter). A
  `dreamLease` row in `memory_meta` is claimed with one `INSERT … ON CONFLICT DO UPDATE … WHERE
  expired` statement (10-min expiry, stale taken over) and the due-check is repeated under it; no
  transaction spans the model call. `proposeMemoryConsolidation()` sees each fact's saved date
  (newer wins) and may merge one id (a rewrite, e.g. relative → absolute date). `planDream()`
  validates in code: disjoint groups, same-`projectPath`/`category`/`source_id` merges only, equal-or-empty
  `context` (the label is kept; merged text may not borrow any label word, short names included, articles/prepositions aside — `borrowsContext`), non-empty text, drops capped
  at max(3, 20%); every shared row is reviewed, 150 per model call (merges never span a chunk), and the
  model sees today's date so it can drop follow-ups more than two weeks past. `applyConsolidation()` is one `BEGIN IMMEDIATE`: lease still
  ours + every touched row unchanged, else abort with no partial mutation; before/after images go
  to `memories_history` (pruned after 30 days) — any new `memories` column must be carried through
  apply/history/undo or a merge silently clears it (#646 added category/source, #856 context). Merged rows keep the group's newest `created_at`
  so a dream never counts toward the next one's "5 new". **Undo last dream** (`restoreDreamRun`)
  restores only groups whose after-image (text, project, category) is still intact and reports the rest as kept edits. The
  digest is a `memory:dream` bubble + Persona's "Last dream" row — never written into a transcript
  (it would be re-extracted).
