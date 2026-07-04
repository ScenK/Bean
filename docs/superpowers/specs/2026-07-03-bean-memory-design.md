# Bean's Memory — Design

> Status: approved 2026-07-03. Confirm-at-close flow revised 2026-07-03 (see that section) to
> gate extraction behind an explicit confirm step with a loading state. Next step:
> implementation plan (writing-plans).

## Goal

Give Bean a memory. When the user chats with Bean via the chat panel, Bean should
remember the few things worth remembering. Memory is **extracted when the chat panel
closes** (with user confirmation) and **recalled when the chat panel reopens**. Memory is
not appended to every talk indiscriminately — only curated, critical facts. The user can
**see and edit** everything Bean knows in the persona panel.

Alongside this, the chat becomes a smarter orchestrator: it is aware of **enabled** skills
only and its proposals are informed by recalled memory.

## Decisions (locked)

- **Scope:** both layered — global "about you" memories + per-project memories.
- **Write path:** confirm-at-close. Closing the chat triggers extraction, Bean shows what
  it wants to remember, the user confirms, then the window closes.
- **Plan shape:** unchanged — one `propose_run` → one skill → one project → one instruction.
  The orchestrator improvement is enabled-only skills + memory-informed matching, not a new
  execution engine. Bean stays fire-and-forget (per
  `convention-launch-hands-off-to-terminal`).
- **Recall filter:** inject all. The curated store stays small because "critical only" is
  enforced at write time, so recall needs no retrieval step.
- **Project association + storage:** central, model-tagged. One global
  `~/.bean/memory.json`; each entry optionally carries a `projectPath` the extraction pass
  infers from an enum of known project paths. Keeps users' repos clean and sidesteps the
  "which project is the chat in" problem (the chat sees all projects at once).

## Data model

New type in `@bean/core`:

```ts
interface Memory {
  id: string;            // stable, for edit/delete in the persona panel
  text: string;          // the fact, one line
  projectPath?: string;  // undefined = global "about you"; else a registered project's path
  createdAt: string;     // ISO; ordering + "remembered on" display
}
```

Stored as `Memory[]` in `~/.bean/memory.json`. New path helper `memoryFile(dir)` in
`config.ts`.

## Core modules (pure, dependency-injected)

Mirror the existing `persona-store.ts` / `converse.ts` shape — zero Electron, explicit paths,
degrade to `[]` on missing/invalid input, never throw except where noted.

- **`memory.ts`** — the `Memory` type and `isValidMemory`.
- **`memory-store.ts`** — `loadMemories(file)` (missing/invalid → `[]`),
  `saveMemories(file, Memory[])`. Same structure as `persona-store.ts`.
- **`memory-extract.ts`** — `extractMemories(transcript, existing, projects, deps)`.
  Runs one `deps.chat` call exposing a `remember` tool whose `projectPath` is
  **enum-constrained to known project paths** (same technique as `proposeRunTool` in
  `converse.ts`, so the model can't invent a path). Returns
  `MemoryCandidate[] = { text; projectPath? }`. Strict "what counts as critical" system
  prompt: durable preferences, working style, project conventions/decisions/gotchas,
  recurring context — never one-off task details, restated existing memories, or ephemera.
  `existing` is passed so the model avoids duplicates. Returns `[]` on any failure or empty
  transcript.

## Recall + orchestrator (changes to existing code)

- **`converse()`** gains a `memories: Memory[]` parameter (placed after `persona`). When
  non-empty it injects a compact block into the system prompt, global first then grouped by
  project name:

  ```
  What you remember:
  - (about the user) prefers pnpm; terse commit messages
  - (project Bean) preload must stay CJS
  ```

  The whole set is injected (no retrieval step) — the store is curated-small by construction.

- **Enabled-skills awareness** happens in `buildChatHandler` (app), *before* calling
  `converse`: `skills.filter(s => s.enabled !== false)`, so both the catalog text and the
  `propose_run` enum only ever see enabled skills. `converse` stays a dumb function of what
  it is given. The same handler loads memories via `loadMemories` and passes them through.

## Confirm-at-close flow

Closing the chat becomes two-phase, intercepted in **main** on the chat `BrowserWindow`:

1. First `close` event → `preventDefault()`. If the transcript has ≥1 real exchange, send
   `chat:review-before-close` to the renderer and set an `allowClose` flag so the *second*
   close is not intercepted. Empty transcript → straight to `allowChatClose()`, no card at
   all.
2. Renderer shows one card, driven by a `closeFlow` stage (`confirm` → `loading` →
   `review`):
   - **`confirm`** — *"Before I go — want me to look for things to remember?"* with
     **Extract** / **Skip** buttons. No LLM call yet — this is the opt-in gate, so the wait
     that follows is expected rather than a silent hang.
   - **Extract** clicked → stage becomes **`loading`** (*"Thinking about what to
     remember…"*, no buttons, no cancel — the existing timeout below is the only backstop)
     and *then* `window.bean.extractMemories(transcript)` fires. The handler loads
     `projects` and existing memories itself; the renderer only passes the transcript.
   - Result `[]` (nothing found, timeout, or error) → `allowChatClose()` directly, card
     disappears. Non-empty → stage becomes **`review`**: each candidate as an editable line
     with a checkbox (default checked), grouped global vs project, plus **Remember** /
     **Skip**.
   - **Skip** at the `confirm` stage → `allowChatClose()` immediately; nothing is ever sent
     to the model.
3. **Remember** (from `review`) → merge selected into the store, `saveMemories`, then
   `window.bean.allowChatClose()`. **Skip** (from `review`) → `allowChatClose()` with no
   write. Main then destroys the window.

Safety rails (this interception is the one risky part):

- Extraction gets a 20s timeout (`REVIEW_TIMEOUT_MS`) — a real reasoning-model call routinely
  takes ~5s+, so this is a backstop against a genuinely hung request, not a normal-path
  budget; on timeout or `[]` candidates, skip the card and close immediately.
- The `allowClose` guard prevents an intercept loop; force-quit / app-quit paths skip review.
- Respects `safety-window-behavior`: chat is its own component window, so this does not
  touch the shared avatar/intake window.

## Persona panel — memory section

Add a **Memory** block below the existing name/tone editor in `PersonaPanel.tsx`:

- **About you** — global memories; each row inline-editable with a `×` delete.
- **Per project** — memories grouped by project name, same affordance.
- **+ Add** to hand-write a memory (global, or pick a project).
- Saves the whole array via `saveMemories`, matching how `SkillsPanel` rewrites the projects
  array.

This is the single see-and-edit / audit home for what Bean knows.

## IPC + channels

Per `convention-ipc-channels`, channel names live in `channels.ts`:

- `listMemories` → `Memory[]`, `saveMemories(Memory[])` → void
- `extractMemories(transcript)` → `MemoryCandidate[]`
- `chat:review-before-close` (main → renderer), `allowChatClose` (renderer → main)
- `bean.d.ts` gains the matching `window.bean` methods.

## Files

**New:** `core/src/memory.ts`, `core/src/memory-store.ts`, `core/src/memory-extract.ts`;
tests `core/__test__/memory-store.test.ts`, `core/__test__/memory-extract.test.ts`.

**Changed:** `core/src/config.ts` (`memoryFile`), `core/src/converse.ts` (+`memories`
param & block), `core/src/index.ts` (re-exports); app `ipc.ts` (enabled filter + memory
handlers + chat handler loads memories), `main.ts` (wiring + close intercept),
`channels.ts`, `preload.ts`, `bean.d.ts`, `PersonaPanel.tsx`, `ChatWindow.tsx`
(confirm/loading/review card stages), `shared.css` (loading-state style).

## Testing

- `memory-store`: load/save round-trip, missing → `[]`, invalid entries dropped.
- `memory-extract`: fake `chat` returning `remember` calls → candidates; invalid
  `projectPath` dropped; failure/empty → `[]`; existing-dedup.
- `converse`: memory block injected when present, absent when empty; proposal behavior
  unchanged.
- `ipc`: chat handler excludes `enabled:false` skills from catalog + enum; memory handlers
  round-trip.
- `ChatWindow`: manual/dev-check only (no test harness for this component today) — confirm
  → skip closes with zero `extractMemories` calls; confirm → extract → empty result closes
  with zero writes; confirm → extract → candidates shows the review card with the right
  items checked.
- Gate: `pnpm test && pnpm typecheck` green.

## Out of scope (YAGNI)

Per-conversation relevance retrieval, embeddings, pinning, multi-step plans, per-skill
rationale on the card, in-repo `.bean/memory.json`. All revisitable once the loop proves out.
