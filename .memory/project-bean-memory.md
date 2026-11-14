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
- **Per-turn capture (#461):** after each typed, non-incognito chat reply (autoMemory on, no
  explicit `remember` that turn, no converse error), the host's chat sessions (`chat-sessions.ts`) fire
  `captureTurn` off the reply path: `extractMemories(…, { latestTurn: true })` cites only the
  latest turn (≤6 prior turns ride as context), appends, and sends `memoryUpdated` to that chat
  window → a `🧠 Memory updated — … · Undo` row (Undo = `deleteMemories` on exactly those ids). No
  avatar bubble; a per-turn failure only logs (close retries it) — unless the window already
  closed, then it raises the `memory:error` bubble. `memory.ts` tracks, per chat (mount id), the
  turn ids captured/in flight, the saved ids (pending for dream until the window closes), the live
  🕶 chip (`chatIncognito` channel — a request's `incognito` is a send-time snapshot, so it's
  re-checked before the model call and the insert; a closed window's id is remembered so a reply
  settling after close can't recreate its state and skip the chip; an incognito close also flips the
  retained state an in-flight capture holds; the renderer sends the chip from the click handler,
  never an effect, so a close right after the click can't beat it), and a queue: captures run one at a time so
  facts are saved in turn order (later-saved-wins stays right). **Close is a catch-up:** turns carry their renderer id,
  already-captured ones are downgraded to non-citable context, and facts undone in the window ride
  along as `rejected` (shown to extraction as already remembered) so close won't re-save them.
  Config `autoMemory` (default true; Settings → Memory) off = explicit remember/forget only.
  The per-window `🕶` chip (incognito) makes a chat write nothing.
- **Trust boundary:** `ChatTurn.source` is recorded when a turn arrives; only `role: "user"` +
  `source: "typed"` turns are citable (`isCitable`). A delegate loopback, a composed skill prompt,
  the Save-to-notes command, ambient chatter, and compaction summaries all travel as role "user",
  so the role can't be trusted. Every candidate must `quote` a span of a typed turn
  (`validateCandidate`), and every fact clause must be carried by one quote clause (or by a
  comma-joined reason pair, `since/because X, Y`, when neither half is negated — never by words
  pooled across unrelated clauses): Latin content
  words (4+ chars, minus `FRAMING`) match on a shared prefix of min(len, 5) ≥ 4 chars, where a
  4-char stem may only gain ≤2 chars ("live"~"lives", never "java"~"javascript"); Han/Kana/Hangul
  runs need every character bigram present. Polarity is checked on each occurrence of the quote
  *widened to its clause* in the source, so a cropped quote can't shed a negation. Instruction-
  (EN + CJK/Korean cues), secret-, Bean-subject, >300-char, and mostly-link/code quotes are
  rejected in code. `extractMemories` returns `{ candidates, rejected, failed }` (rejected =
  validation rejects, failed = model call threw); desktop `rememberOnClose` acts on all three.
  The recall block frames memories as data and tags them `[id]`.
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
- **Context label (#856):** `memories.context` (nullable) is a one-line topic the extraction model
  writes from the window it saw, so a fragment ("Only in the staging cluster") stays readable —
  `text` validation is unchanged, so the referent can't go there. `validateContext` in code:
  control chars/brackets stripped, ≤80 chars, instruction-/secret-/link-shaped rejected, every word
  in that call's window, exact (normalized) — no prefix stand-ins; a failed label
  is dropped, the fact still saves. Only `extractMemories` passes a window (desktop close/per-turn,
  DM capture), so explicit `remember` and channel capture drop it (#857 adds channel context).
  The spec always offers `context` (byte-stable). Recall renders `[re: <context>] <text>`; both
  recall headers (`memoriesBlock` default + routine) carry `MEMORY_CONTEXT_CLAUSE` (topic note,
  not the user's words); relevance ranking indexes `text + context`. Live check:
  `memory-context.live.test.ts` prints the usable-label share.
- **Capture bar is generous on purpose (owner ask, 2026-11):** extraction keeps current work,
  decisions and anything needing a follow-up (category `Follow-up`), not only durable preferences —
  only step-by-step task instructions and small talk are out. Token cost was explicitly accepted;
  don't tighten the prompts back without asking. The quote-cited validation in code is unchanged.
  Agent-mode steering the user typed is citable at close catch-up (`chatTurns` maps `live` →
  `typed`, a composed `/skill` prompt → `skill`; a hand-off offer's opening is Bean's wording, so
  `startSession` rows are `skill` unless `typed` is passed; agent finals ride as ≤1k non-citable context);
  there is no per-turn capture for live turns.
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
