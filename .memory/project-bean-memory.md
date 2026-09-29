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
  Config `autoMemory` (default true; Settings → Memory) off = explicit remember/forget only.
  The per-window `🕶` chip (incognito) makes a chat write nothing.
- **Trust boundary:** `ChatTurn.source` is recorded when a turn arrives; only `role: "user"` +
  `source: "typed"` turns are citable (`isCitable`). A delegate loopback, a composed skill prompt,
  the Save-to-notes command, ambient chatter, and compaction summaries all travel as role "user",
  so the role can't be trusted. Every candidate must `quote` a span of a typed turn sharing a
  content word with the fact (`validateCandidate`), and instruction-/secret-shaped facts are
  rejected in code. The recall block frames memories as data and tags them `[id]`.
- **Explicit remember/forget:** `makeMemoryTools()` → direct `remember` + `forget_memory` action
  tools, offered only on a typed turn (`ChatRequest.source === "typed"` on desktop). Desktop
  shows a `🧠 Remembered — …` status line; chatops posts a Forget card
  (see [[project-chatops-memory-flow]]).
- **Recall:** `converse()` ranks via `selectRelevantMemories()` — below 20 memories inject all;
  above, an FTS5 bm25 top-12 against the latest user message.
- **Enabled-skills filter** lives in `buildChatHandler` (app `ipc.ts`), not in `converse()`.
- **Edit surface:** Persona's MEMORY section, per-row `updateMemory`/`deleteMemories`/
  `appendMemories` only — see [[safety-memory-append-vs-replace]].
- **Consolidation:** `memory/consolidate.ts`'s `proposeMemoryConsolidation()` (merge/drop over
  the existing list) currently has no caller: the chatops confirm-first tidy-up card, its
  `ConsolidationProposalStore`, and its apply were deleted in #177 PR 1 — a stale card's apply
  could overwrite a Persona edit made after the proposal. Background "dream" consolidation
  (PR 2) replaces it with a lease-guarded, fingerprint-checked transactional apply.

Design spec: `docs/superpowers/specs/2026-07-03-bean-memory-design.md`.

- Gotcha: app `RegisterDeps` (ipc.ts) re-declares `ChatHandlerDeps` fields instead of extending it, so a new chat-handler dep (e.g. `loadMemories`/`dbFile`) must be added to BOTH interfaces and to the `registerIpc` deps object in `main.ts`.
