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
  `reviewBeforeClose` intercept survives only for the running-delegates Keep/Stop prompt). Main
  (`buildMemoryHandlers` in `ipc.ts`) runs `extractMemories` → `appendMemories` and keeps the id
  batch in memory; a non-empty batch shows a `kind: "memory"` avatar bubble whose click opens
  Persona (never undoes — its old click meaning was dismiss). Persona's **Just remembered · Undo**
  deletes exactly that batch's ids; the Undo window lasts until the next batch or app restart.
  A one-shot `auto-memory-notice.json` flag (userData) makes the first bubble explain itself.
  A broken save (`failed`, or any load/store rejection) raises a sticky `memory:error` bubble
  ("Couldn't update memory") via `onMemoryFailure`; nothing worth saving shows no bubble. Logs
  carry the rejected *count* only, never fact text.
- **Per-turn capture (#461):** after each typed, non-incognito chat reply (autoMemory on, no
  explicit `remember` that turn, no converse error), `registerIpc`'s chat handler fires
  `captureTurn` off the reply path: `extractMemories(…, { latestTurn: true })` cites only the
  latest turn (≤6 prior turns ride as context), appends, and sends `memoryUpdated` to that chat
  window → a `🧠 Memory updated — … · Undo` row (Undo = `deleteMemories` on exactly those ids). No
  avatar bubble; a per-turn failure only logs (close retries it) — unless the window already
  closed, then it raises the `memory:error` bubble. Main tracks, per window (webContents id), the
  turn ids captured/in flight, the saved ids (pending for dream until the window closes), the live
  🕶 chip (`chatIncognito` channel — a request's `incognito` is a send-time snapshot, so it's
  re-checked before the model call and the insert), and a queue: captures run one at a time so
  facts are saved in turn order (later-saved-wins stays right). **Close is a catch-up:** turns carry their renderer id,
  already-captured ones are downgraded to non-citable context, and facts undone in the window ride
  along as `rejected` (shown to extraction as already remembered) so close won't re-save them.
  Config `autoMemory` (default true; Settings → Memory) off = explicit remember/forget only.
  The per-window `🕶` chip (incognito) makes a chat write nothing.
- **Trust boundary:** `ChatTurn.source` is recorded when a turn arrives; only `role: "user"` +
  `source: "typed"` turns are citable (`isCitable`). A delegate loopback, a composed skill prompt,
  the Save-to-notes command, ambient chatter, and compaction summaries all travel as role "user",
  so the role can't be trusted. Every candidate must `quote` a span of a typed turn
  (`validateCandidate`), and every fact clause must be carried by one quote clause: Latin content
  words (4+ chars, minus `FRAMING`) match on a shared prefix of min(len, 5) ≥ 4 chars, where a
  4-char stem may only gain ≤2 chars ("live"~"lives", never "java"~"javascript"); Han/Kana/Hangul
  runs need every character bigram present. Polarity is checked on each occurrence of the quote
  *widened to its clause* in the source, so a cropped quote can't shed a negation. Instruction-
  (EN + CJK/Korean cues), secret-, Bean-subject, >300-char, and mostly-link/code quotes are
  rejected in code. `extractMemories` returns `{ candidates, rejected, failed }` (rejected =
  validation rejects, failed = model call threw); desktop `rememberOnClose` acts on all three.
  The recall block frames memories as data and tags them `[id]`.
- **Explicit remember/forget:** `makeMemoryTools()` → direct `remember` + `forget_memory` action
  tools, offered only on a typed turn (`ChatRequest.source === "typed"` on desktop). Desktop
  shows a `🧠 Remembered — …` status line; chatops posts a Forget card
  (see [[project-chatops-memory-flow]]).
- **Recall:** `converse()` ranks via `selectRelevantMemories()` — below 20 memories inject all;
  above, an FTS5 bm25 top-12 against the latest user message.
- **Enabled-skills filter** lives in `buildChatHandler` (app `ipc.ts`), not in `converse()`.
- **Edit surface:** Persona's MEMORY section, per-row `updateMemory`/`deleteMemories`/
  `appendMemories` only — see [[safety-memory-append-vs-replace]].
- **Dream (background consolidation, #177 PR 2):** `memory/dream.ts` `maybeDream()` is checked
  after each desktop auto-save (close batch or per-turn capture; no timer, no boot cost). Due when ≥24h
  since `lastDreamAt` **and** ≥5 memories created since (a `created_at` count — no counter). A
  `dreamLease` row in `memory_meta` is claimed with one `INSERT … ON CONFLICT DO UPDATE … WHERE
  expired` statement (10-min expiry, stale taken over) and the due-check is repeated under it; no
  transaction spans the model call. `proposeMemoryConsolidation()` sees each fact's saved date
  (newer wins) and may merge one id (a rewrite, e.g. relative → absolute date). `planDream()`
  validates in code: disjoint groups, same-`projectPath` merges only, non-empty text, drops capped
  at max(3, 20%), oldest 150 per run. `applyConsolidation()` is one `BEGIN IMMEDIATE`: lease still
  ours + every touched row unchanged, else abort with no partial mutation; before/after images go
  to `memories_history` (pruned after 30 days). Merged rows keep the group's newest `created_at`
  so a dream never counts toward the next one's "5 new". **Undo last dream** (`restoreDreamRun`)
  restores only groups whose after-image is still intact and reports the rest as kept edits. The
  digest is a `memory:dream` bubble + Persona's "Last dream" row — never written into a transcript
  (it would be re-extracted).

- Gotcha: app `RegisterDeps` (ipc.ts) re-declares `ChatHandlerDeps` fields instead of extending it, so a new chat-handler dep (e.g. `loadMemories`/`dbFile`) must be added to BOTH interfaces and to the `registerIpc` deps object in `main.ts`.
