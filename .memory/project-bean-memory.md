# Bean's memory subsystem

`~/.bean/bean.db` (SQLite, `core/src/db.ts`) holds a curated `Memory[]` (`{ id, text,
projectPath?, createdAt }`, `core/src/memory/memory.ts`) in a `memories` table + `memories_fts`
FTS5 index. Global entries have no `projectPath`; project ones carry a registered project's path
(model-tagged during extraction, enum-constrained so it can't be invented). As of the SQLite
migration (see [[safety-memory-append-vs-replace]]), the old `~/.bean/memory.json` /
`~/.bean/notes/*.md` files are imported once on first `openDb()` call and then left untouched —
see `db.ts`'s `migrateFromFiles`.

- **Extract:** `extractMemories()` (`memory/extract.ts`) runs a `remember`-tool pass over a
  finished transcript; strict "durable facts only" prompt; dedups against existing; never throws.
- **Recall:** `converse()` takes a `memories` param, ranks it via `selectRelevantMemories()`
  (`memory/store.ts`) before formatting the "What you remember:" block. Below 20 total memories
  it's still the old "inject everything" behavior; above that it's an FTS5 bm25 top-12 rank
  against the latest user message (a throwaway `:memory:` FTS5 table per call — cheap at this
  scale). `converse()` has no "current project" signal to force-include by (LinkedNote doesn't
  carry one), so that force-include path exists in the function but is unused from this call site.
- **Enabled-skills filter** lives in `buildChatHandler` (app `ipc.ts`), not in `converse()`.
- **Confirm-at-close:** main intercepts the chat window's `close` (guarded by `quitting` +
  an `allowClose` WeakSet), sends `reviewBeforeClose`; the renderer extracts (20s backstop —
  a real reasoning-model extraction takes ~5s, so the timeout must exceed it or it silently
  discards valid memories), shows a review card, then calls `allowChatClose` to re-issue the
  close. Empty transcript or no candidates closes immediately. It persists the picked facts via
  `window.bean.appendMemories` (insert-only), **not** `listMemories`+`saveMemories` — see
  [[safety-memory-append-vs-replace]].
- **Edit surface:** the persona panel's MEMORY section (list/edit/delete/add), persisted via
  `saveMemories` (whole-list replace is correct there — single actor, not a concurrent-writer path).
- **Consolidation:** chatops-only for now. `memory/consolidate.ts`'s `proposeMemoryConsolidation()`
  mirrors `extractMemories`'s one-call/tool-spec shape but reviews the *existing* list for
  merge/drop candidates. Triggered from `bot.ts`'s `handleMemoryAction` right after a successful
  save-memories pushes the total count over 30 — piggybacks on the existing extraction flow
  rather than a new scheduler. Confirm-first via `ConsolidationProposalStore` (same
  Map+seq+10-min-expiry shape as the other proposal stores) and a `consolidationProposalCard`/
  `consolidationResultCard` pair in `cards-api.ts`. No desktop equivalent yet (Settings already
  lets you edit the list directly) — flagged as a follow-up if desktop parity is wanted.

Design spec: `docs/superpowers/specs/2026-07-03-bean-memory-design.md`.

- Gotcha: app `RegisterDeps` (ipc.ts) re-declares `ChatHandlerDeps` fields instead of extending it, so a new chat-handler dep (e.g. `loadMemories`/`dbFile`) must be added to BOTH interfaces and to the `registerIpc` deps object in `main.ts`.
