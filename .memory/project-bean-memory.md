# Bean's memory subsystem

`~/.bean/memory.json` holds a curated `Memory[]` (`{ id, text, projectPath?, createdAt }`,
`core/src/memory.ts`). Global entries have no `projectPath`; project ones carry a registered
project's path (model-tagged during extraction, enum-constrained so it can't be invented).

- **Extract:** `extractMemories()` (`memory-extract.ts`) runs a `remember`-tool pass over a
  finished transcript; strict "durable facts only" prompt; dedups against existing; never throws.
- **Recall:** `converse()` takes a `memories` param and injects a "What you remember:" block
  after the catalog. The whole (small, curated) set is injected — no retrieval step.
- **Enabled-skills filter** lives in `buildChatHandler` (app `ipc.ts`), not in `converse()`.
- **Confirm-at-close:** main intercepts the chat window's `close` (guarded by `quitting` +
  an `allowClose` WeakSet), sends `reviewBeforeClose`; the renderer extracts (20s backstop —
  a real reasoning-model extraction takes ~5s, so the timeout must exceed it or it silently
  discards valid memories), shows a review card, then calls `allowChatClose` to re-issue the
  close. Empty transcript or no candidates closes immediately.
- **Edit surface:** the persona panel's MEMORY section (list/edit/delete/add), persisted via
  `saveMemories`.

Design spec: `docs/superpowers/specs/2026-07-03-bean-memory-design.md`.

- Gotcha: app `RegisterDeps` (ipc.ts) re-declares `ChatHandlerDeps` fields instead of extending it, so a new chat-handler dep (e.g. `loadMemories`/`memoryFile`) must be added to BOTH interfaces and to the `registerIpc` deps object in `main.ts`.
