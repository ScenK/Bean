# Todo-Driven Routines — Design

**Date:** 2026-07-15
**Status:** Approved pending user review
**Scope:** v1. User-owned checkbox follow-ups and Bean-filed follow-ups from run results are
explicitly deferred to v2 (see "Deferred").

## Problem

Routines today run a fixed list of steps on a cron schedule. There is no way to queue one-off
engineering tasks during the day and have Bean work through them overnight. This feature adds a
consume-once **todo queue per routine**: a routine can be marked *todo-driven*, in which case its
steps become a **pipeline applied to each queued todo** (e.g. plan → implement → open-MR), and the
routine skips its scheduled run entirely when the queue has no pending items. This also lays the
data foundation for the future Daily Dashboard.

## Model

### Routine type

`Routine` gains an optional discriminator:

```ts
interface Routine {
  // ...existing fields...
  todoDriven?: boolean; // absent/false = today's "always runs" behavior, unchanged
}
```

- **Always runs** (default): existing behavior, byte-for-byte. Existing `~/.bean/routines/*.json`
  files remain valid with no migration.
- **Todo-driven**: the routine owns a queue of todos. At each scheduled fire time, if the queue has
  no `pending` items the run is **skipped** (not recorded as a run, no digest; `lastRun` still
  advances so the schedule doesn't re-fire). Otherwise each pending todo is run through the
  routine's full step pipeline.

### Todo item

Todos are **plain text** — no skill/project/model on the item. The routine's steps supply all of
that; the todo's text is the task context injected into every step.

```ts
interface TodoItem {
  id: string;               // uuid
  routine: string;          // owning routine name
  text: string;             // the task, one sentence or short paragraph
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;        // ISO
  finishedAt?: string;      // ISO, set on done/failed
  resultSummary?: string;   // digest section / error summary
  order: number;            // manual ordering within the queue
}
```

### Storage

New `todos` table in `~/.bean/bean.db` (alongside `notes`/memories), managed by a new
`packages/core/src/todo-store.ts` following `note-store.ts` conventions (pure, path-injected,
better-sqlite3 via `db.ts`).

Why SQLite and not a JSON file: todos are a hot queue with concurrent writers — chat inserts
items while the scheduler flips per-item statuses, and chatops bots share the same DB. Per-row
`UPDATE ... WHERE id=?` sidesteps the JSON read-modify-write race documented in
`.memory/safety-memory-append-vs-replace.md`.

Store API (all synchronous like `note-store.ts`, or async matching whichever pattern `db.ts`
exposes — follow the existing note-store idiom):

- `addTodo(routine, text)` → `TodoItem` (order = max+1)
- `listTodos(routine)` / `listAllTodos()` (dashboard-ready)
- `updateTodoStatus(id, status, resultSummary?)` (stamps `finishedAt` on done/failed)
- `editTodoText(id, text)` (pending items only)
- `reorderTodo(id, newOrder)`
- `deleteTodo(id)`
- `clearFinished(routine)`
- `recoverInterrupted()` → marks any `running` item `failed` with summary `"interrupted"`
  (called once at app startup)
- `retryTodo(id)` → failed → pending

Deleting a routine deletes its queue. Renaming a routine renames its todos' `routine` column in
the same operation.

## Execution (`routine-runner.ts`)

`runRoutine` gains todo awareness via DI (core stays Electron-free; the store is injected by the
app, not imported):

```ts
interface RoutineRunnerDeps {
  // ...existing...
  todos?: {
    listPending: (routine: string) => TodoItem[];
    setStatus: (id: string, status: TodoItem["status"], resultSummary?: string) => void;
  };
}
```

For a todo-driven routine:

1. Load pending todos in `order`. (The scheduler has already skipped the run if empty; the runner
   also treats an empty list as a no-op success so a race can't produce a garbage run.)
2. **Per-todo, whole-pipeline:** for each todo — mark `running`, then run steps 1→N sequentially,
   exactly like today's step loop, with two changes:
   - Each step's effective instruction is the step's own instruction plus a
     `Queued task:\n<todo text>` block, so every step knows which task it is working on.
   - `priorOutputs` chaining is **scoped to the current todo** (step 2 of todo B sees todo B's
     step-1 output, never todo A's).
3. A step failure fails that todo: mark it `failed` with the error, skip its remaining steps, and
   continue with the next todo. A todo whose steps all succeed is marked `done` with a short
   result summary (final step's output, capped like `RunRecord.steps[].summary`).
4. Digest: one section per todo ("one briefing per task"), composed by the existing
   `composeDigest` path — the digest prompt is extended to group by task when todo results are
   present. Run `status` is `"failed"` if any todo failed (matching existing "at least one step
   failed" semantics). `RunRecord.steps` records one entry per (todo × step) executed, prefixed
   with the todo text in the summary, so history stays informative without a schema change.
5. Timeouts, `MAX_TOOL_ROUNDS`, chat-step behavior, and the no-propose-tools rule are unchanged
   and apply per step as today.

**Why whole-pipeline-per-todo** (todo A runs steps 1..N, then todo B) rather than stage-wise (all
todos through step 1 first): it matches "one briefing per task", isolates failures, and keeps the
prior-outputs chaining semantics simple. Approved explicitly by the user.

**Interrupted runs:** if Bean quits mid-run, `recoverInterrupted()` at next startup marks stuck
`running` items `failed ("interrupted")` — visible and retryable, never silently lost. No
automatic retries anywhere: retry is a manual action (per `.memory` no-catch-up spirit and the
approved failure-handling decision).

## Scheduler (`app/src/routine-scheduler.ts`)

Unchanged tick loop. One addition: for a todo-driven routine at fire time, consult
`listPending(routine.name).length === 0` → skip (advance `lastRun`, do not record a run, do not
mark `missed`). Skip-if-running and no-catch-up behavior untouched.

## Chat capture (`converse.ts` — `propose_todo`)

New confirm-first tool `propose_todo`, following the `propose_note` pattern exactly:

- Offered only when at least one todo-driven routine exists; the tool's description lists the
  available todo-driven routine names.
- Args: `{ routine: string, text: string }`. Bean drafts both; with a single todo-driven routine
  the choice is trivial. Invalid routine name → tool result explains and lets the model retry
  within the existing tool loop.
- The proposal is returned on `ConverseResult` (new optional `proposedTodo` field), rendered in
  the chat as a **TodoProposalCard** (confirm / dismiss, like NoteCard/SkillCard); on confirm the
  renderer calls the new IPC to insert a `pending` item.
- Available in the chat window **and** chatops (Teams/Discord) — chatops already renders
  confirm-first proposals. Routine runs themselves do **not** get `propose_todo` (routines keep
  their no-propose-tools rule).

## UI (Routines panel — no new panels)

Per the approved mockup (`Nightly-Run` screenshot):

- **Type toggle** in the routine editor: `Always runs | ⚡ Todo-driven`, with the explanatory
  copy. Switching to todo-driven reveals the Queue section; switching back hides it (queue rows
  are kept in the DB, not deleted, so a toggle round-trip loses nothing).
- **Queue section** (todo-driven only): pending items in order with status chips
  (`running now` / `pending`), finished items below with strikethrough + `done · <relative day>`
  or `failed` + error summary + **Retry**; inline add ("+ Queue a todo"), edit (pending only),
  delete, reorder (up/down or drag); "Clear finished". A pending-count line ("3 pending · gates
  this routine") and the cadence line's "only if the queue has items" annotation.
- **Steps section**: unchanged editor; header copy switches to "run in order on each queued todo ·
  one digest at the end" when todo-driven.
- "Run now" on a todo-driven routine with an empty queue is disabled with a hint ("queue a todo
  first").

## Wiring

- `channels.ts`: new channels (`bean:todos-list`, `bean:todos-add`, `bean:todos-update`,
  `bean:todos-delete`, `bean:todos-reorder`, `bean:todos-clear-finished`, `bean:todos-retry`) —
  defined once, never string-literaled (`.memory/convention-ipc-channels.md`).
- `preload.ts`: corresponding `window.bean.todos.*` bridge + `bean.d.ts` types.
- `ipc.ts`: thin `buildTodoHandlers(store)` separable from Electron.
- `main.ts`: construct the store against `bean.db`, call `recoverInterrupted()` at startup, pass
  the todos dep into the scheduler's runner deps.
- Renderer imports core **types** freely but values only from node-free subpaths
  (`.memory/convention-renderer-imports-node-free-subpaths.md`); the todo store is main-process
  only, reached via IPC.

## Validation & compatibility

- `isValidRoutine`: accept optional boolean `todoDriven`. Old files (field absent) stay valid.
- A todo-driven routine still requires ≥1 step (the pipeline can't be empty).
- Todo `text` must be non-empty trimmed; `routine` must reference an existing routine at insert
  time (enforced at the IPC/tool layer, not the store, so the store stays dumb).

## Testing

- `todo-store` unit tests: CRUD, ordering, status transitions, `recoverInterrupted`,
  `clearFinished`, retry, routine rename/delete cascade.
- `routine-runner` tests: todo-driven drain (2 todos × 2 steps ordering), per-todo prior-output
  scoping, step failure → todo failed + next todo still runs, empty queue no-op, status/summary
  stamping, digest grouping.
- Scheduler test: empty queue skips (lastRun advances, no run recorded).
- `converse` test: `propose_todo` offered only with a todo-driven routine present; proposal
  round-trip; invalid routine name handling.
- Validator tests for `todoDriven`.
- Gate: `pnpm test && pnpm typecheck`. UI paths touched are renderer-only; if any change touches
  app boot/IPC, check the advisory e2e job before merge (per AGENTS.md).

## Deferred (v2)

- **User-owned checkbox follow-ups** (`owner: "user"` items Bean never executes) and
  **Bean-filed follow-ups** (a `file_todo` act-now tool letting routine steps drop human
  follow-ups from run results, with `↳ step N` provenance badges) — needs its own design pass,
  including a design-team question on how noisy Bean may be.
- Daily Dashboard consuming `listAllTodos()` and run history.
