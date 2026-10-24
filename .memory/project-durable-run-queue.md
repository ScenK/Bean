---
name: project-durable-run-queue
description: Cross-process delegate-run records (run-queue.ts, ~/.bean/runs/<runId>.json, tracks the delegate CHILD's pid, never a lock — #385 lifted the one-run-per-project rule) for crash cleanup, split from interrupted-run reporting (outbox.ts reuse); why release waits for the child to be confirmed dead; why everything on the interrupt path is fully synchronous and main.ts's before-quit does NOT use preventDefault.
metadata:
  type: project
---

Desktop chat (`delegate-tasks.ts`), the Discord/Teams bots (`RunRegistry`, `LiveSessionRegistry`,
one instance per bot **process**) and sprout delegate steps (`routine-steps.ts`) each record every
tracked run so a crash can be cleaned up, and quitting mid-run leaves a durable "interrupted" notice.

## No project lock (#385)

Until #385, `reserveRun` held one O_EXCL file per project path and every surface refused a second
run on the same project (`ALREADY_RUNNING`, live-session `"project"`, sprout `RunBusyError` +
watch-todo deferral, gated `hold.reserved`). It only serialized: the agents doing the work isolate
themselves in their own git worktree off the local checkout. All of that is deleted — don't bring
a per-project refusal back. Runs on one project overlap on every surface. What stays per-scope:
one live session per channel, and two runs in one thread on the same CLI never share a resumed
session (`RunRegistry.start` drops `resume` + `BUSY_THREAD_NOTICE`, #384).

## Records vs. reporting — deliberately two different mechanisms

- **Records** ("which delegate children might be orphaned?") — `packages/core/src/run-queue.ts`,
  `recordRun`/`updateRunPid`/`releaseRun`, one JSON file per run under
  `~/.bean/runs/<runId>.json` (`{ id, projectPath, pid, createdAt }` — nothing else). The run id
  is server-generated (a surface's `newId`/`randomUUID`), so file-per-run writes never race.
  `recordRun` never refuses.
- **Reporting** ("tell the surface what happened") — reuses `outbox.ts` directly (added a
  `"chat"` transport alongside `"discord"`/`"teams"`) rather than inventing a
  `proposed→running→done|failed|interrupted→reported` state machine. "done"/"failed" already
  report live, in-process. Only "interrupted" needs durable delivery, and outbox already does
  durable, at-least-once cross-process delivery (main.ts claims + acks its `"chat"` notices at
  boot). Widening `OutboxMessage.transport` required also fixing `claimOutbox`'s orphan-sweep
  check (it only knew `"teams-"`/`"discord-"` prefixes — a `"chat-*.json"` file would've been swept
  as an orphan by the next Discord/Teams poll before main.ts's own one-shot claim saw it).

## Boot cleanup: two different policies

- **Desktop** (`main.ts` → `sweepDeadRuns`): deletes records whose pid is dead (or that don't
  parse). **Never kills** — the bots share `runs/`, and a live record may be their running child.
- **Headless bot** (`headless-routines.ts` → `clearReservations`): the bot owns `~/.bean` alone,
  so it SIGKILLs each recorded process group and deletes every file. After a container restart
  pids start low again, so a stale record's pid can match an unrelated live process.
- Both treat pre-#385 per-project `<sha256>.json` reservation files like any record (same shape).
- Pid liveness is `process.kill(pid, 0)`. POSIX-only; revisit if Windows packaging is ever added.

## The record tracks the delegate CHILD, and release waits for it to be confirmed dead

- The record is created against the *owning* process's pid (nothing else exists yet), then
  `updateRunPid(dir, runId, handle.pid)` switches it to the delegate child once spawned
  (`DelegateHandle.pid`). Resumed chatops runs wait for `onSessionStart` (a rejected resume
  re-spawns, and the first child dies). Per-turn live sessions (codex/opencode) keep the bot pid.
- `cancel()` releases only inside the confirmation callback (`onCancelled`, fired from the
  delegate's own `close` event) — the record must outlive a child still shutting down.
- `interruptAll()`/`forceKillAll()` don't release at all: the process exits right after, and
  `delegate.ts`'s SIGKILL-escalation timer never fires on a dying event loop. Boot cleanup finds
  the record instead.

## Everything on the interrupt path is fully synchronous

`RunRegistry.interruptAll()`/`cancel()` and `delegate-tasks.ts`'s equivalents, along with
`run-queue.ts`'s `recordRun`/`releaseRun`/`updateRunPid`, are plain synchronous
functions — no `async`, no `Promise` return type. `outbox.ts`'s `enqueueOutbox`/`claimOutbox`
stay `async`-declared for call-site compatibility with existing `await`ers, but are sync
internally (`node:fs`, not `fs/promises`) for the same reason.

Two independent reasons drove this, not just one:
- **Settle callbacks are synchronous.** `RunRegistry`'s/`delegate-tasks`' settle paths call
  `releaseRun` fire-and-forget from inside a synchronous callback (`onDone`/`onError`/`cancel`'s
  completion); an unawaited async write could land after the process exits.
- **`interruptAll()` can't rely on being awaited at all.** It's called from Electron's
  `before-quit` and a bare `process.on("SIGTERM", ...)` (bot subprocesses) — neither reliably
  supports waiting on real async work. An earlier version of this tried
  `event.preventDefault()` + `await interruptAll()` + re-trigger `app.quit()` from `main.ts`'s
  `before-quit`; that reintroduced exactly the fragility this file's own SIGINT/SIGTERM handlers
  already exist to work around (see the comment above `if (!app.requestSingleInstanceLock())`) —
  it manifested as Ctrl+C during `pnpm dev` sometimes never actually quitting the Electron
  process (tray icon stayed alive) even though a subsequent manual "Exit" click worked fine.
  Making the whole interrupt path synchronous end-to-end removes the async gating entirely, so
  `before-quit` doesn't need `preventDefault()` at all — it now matches every *other* listener in
  `main.ts`, which are all plain synchronous fire-and-forget:
  ```ts
  app.on("before-quit", () => {
    quitting = true;
    interruptAllDelegates(); // synchronous — fs work is done by the time this call returns
  });
  ```
  Discord/Teams bot subprocesses follow the same shape: `runs.interruptAll(); process.exit(0);`
  with no `.finally()`/promise chain needed.

## Explicitly out of scope

Sprout steps (`routine-steps.ts`) record their runs but leave no outbox notice — they already have
their own interruption tracking (`RoutineState.missed`, `recoverInterruptedTodos`).

No literal "resume" of a dead detached child (no fd to reattach to) — the reported message just
prompts the user to re-ask.

## Quit must SIGKILL, not just cancel (#190)

Delegates spawn `detached` (own process group), and `cancel()`'s SIGTERM→5s→SIGKILL escalation
never reaches SIGKILL when the app exits right after — routine-step `claude -p` runs survived quit
as orphans (SIGTERM alone didn't stop them). `delegate.ts` keeps every unsettled run in a module
registry and `killAllDelegates()` group-SIGKILLs them synchronously; `main.ts`'s first
`before-quit` handler calls it right after `interruptAllDelegates()` (which still writes the outbox
notices). One call covers every `runDelegate` caller — don't replace it with per-caller handle sets.
