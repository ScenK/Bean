# project-todo-driven-routines

Todo-driven routines: `Routine.todoDriven` turns the step list into a pipeline run once per
queued todo (whole-pipeline-per-todo, prior-outputs scoped per todo; a failed step abandons
that todo but the next still runs — note the asymmetry with plain routines' continue-on-failure).
Queue items are plain text in `bean.db`'s `todos` table (`todo-store.ts`; SQLite not JSON per
safety-memory-append-vs-replace). Scheduler consumes an empty-queue fire by advancing lastRun
WITHOUT recording a run; `runNow` relies on the runner's own empty-queue no-op instead.
`running` items are failed as "interrupted" at startup (`recoverInterruptedTodos` in main.ts) —
retry is always manual. Chat/chatops capture is confirm-first `propose_todo` (enum-gated to
todoDriven routine names); routine runs themselves never get propose_* tools. Deleting a routine
cascades its todos (`onRoutineDeleted`); renames don't exist in the panel, so
`renameTodosRoutine` is exported but unwired. Deferred to v2: user-owned checkbox follow-ups
and Bean-filed follow-ups from run results.

Addendum (Task 11 cross-check): no undocumented gaps found — every spec section maps to shipped
code (Model → `Routine.todoDriven`/`isValidRoutine` in `routine-store.ts` + `TodoItem`/CRUD in
`todo-store.ts`; Execution → `runRoutine`/`runSteps` in `routine-runner.ts`; Scheduler →
`routine-scheduler.ts`'s `hasPendingTodos` skip; Chat capture → `propose_todo` in `converse.ts`
plus `TodoCard`/`TodoProposalCardInput` in the chat window, Teams, and Discord; UI → the type
toggle and Queue section in `RoutinesPanel.tsx`, including the disabled-Run-now-on-empty-queue
hint; Wiring → `channels.ts`/`buildTodoHandlers`/`main.ts`'s startup recovery + delete cascade +
runner-deps injection; Testing → `routine-runner.test.ts`'s "todo-driven routines" describe block
covers per-todo ordering, prior-output scoping, failure isolation, and empty-queue no-op at the
unit level. One item never got real interactive coverage: the end-to-end `pnpm dev` click-through
(queue a todo, hit Run now, watch it go running → done in the live UI) — this environment has no
GUI automation, so Tasks 8/9 and this task's own boot-check could only confirm the app boots
clean and typechecks/builds, never a real click-through. Accepted as a known limitation, not a
blocker; the unit tests above are the closest available evidence for that flow's correctness.

Member todos (#283): `todos.created_by` is set only for a **non-owner** chatops speaker; NULL =
the owner's (desktop, watch-created, legacy, or the owner on chat). Non-owners may queue only on
`memberTodoEligible` routines (todo-driven, no `delegate`/`command` step) — checked at catalog
(`listTodoRoutines(member)`), confirm (`resolveTodoRoutine(..., member)`), and again in the runner
at drain against the current definition (refused todos fail, the rest still run). Because the drain
gate keys on NULL vs non-NULL, no routine host needs an owner id — don't stamp the owner's id.
Chatops `list_todos`/`cancel_todo` filter by creator in SQL; todo proposal taps are bound to the
requester + conversation, checked before `claim()`.

Deferral (#380) is watch-only: only watch todos reserve their project (`reserve: Boolean(routine.watch)`
in `routine-runner.ts`), so only they can hit `RunBusyError` before a step ran → todo back to
pending, `deferred: true`, scheduler records nothing, next 30s tick retries. The desktop host emits
a `drop` status (bubble dismissed) instead of a fake "Done". Enabling reservation for cron todo
routines would make a deferral consume the cron slot (`lastRun` is stamped at start) — needs its own
retry design.
