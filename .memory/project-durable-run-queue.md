---
name: project-durable-run-queue
description: Cross-process delegate-run reservation (run-queue.ts, atomic O_EXCL keyed by project path, tracks the delegate CHILD's pid) split from interrupted-run reporting (outbox.ts reuse); why release is deferred until the child is confirmed dead; why everything on the interrupt path is fully synchronous and main.ts's before-quit does NOT use preventDefault.
metadata:
  type: project
---

Desktop chat (`delegate-tasks.ts`) and the Discord/Teams bots (`RunRegistry`, one instance per
bot **process**) each only enforced "one delegate run per project path" within their own process.
Nothing stopped the same project being delegated to from two surfaces at once, and quitting
mid-run just killed the child and forgot about it.

## Reservation vs. reporting — deliberately two different mechanisms

- **Reservation** ("is project X already claimed?") — `packages/core/src/run-queue.ts`,
  `reserveRun`/`releaseRun`, one JSON file per project path under
  `~/.bean/runs/<sha256(projectPath)>.json` (`{ id, projectPath, pid, createdAt }` — nothing
  else). The filename is *deterministic* (hash of the project path, not a random id) so every
  process asking about the same project computes the same path, and the reservation is created
  via `writeFileSync(path, data, { flag: "wx" })` (`O_CREAT|O_EXCL`) — an atomic kernel-level
  create-if-not-exists, not a directory-scan-then-write-a-new-file. An earlier version scanned
  the directory for any existing reservation on that path before writing a new uniquely-named
  file; a code review caught the TOCTOU hole that left — two processes could both scan, both see
  nothing, and both write, defeating the whole point of this module. Checked as a *second*,
  cross-process layer after each caller's own existing synchronous in-memory guard
  (`RunRegistry.byProject`, delegate-tasks' in-memory task map) — the in-memory check is still
  what prevents same-process, same-tick double-starts; the disk check only extends that
  invariant across processes.
- **Reporting** ("tell the surface what happened") — reuses `outbox.ts` directly (added a
  `"chat"` transport alongside `"discord"`/`"teams"`) rather than inventing a
  `proposed→running→done|failed|interrupted→reported` state machine. "done"/"failed" already
  report live, in-process, exactly like before this change — nothing to persist there. Only
  "interrupted" needs durable delivery, and outbox already does durable, claim-once-and-delete
  cross-process delivery. Widening `OutboxMessage.transport` required also fixing
  `claimOutbox`'s orphan-sweep check (it only knew about `"teams-"`/`"discord-"` prefixes — a
  `"chat-*.json"` file would've been swept as an orphan by the next Discord/Teams poll before
  main.ts's own one-shot claim ever saw it).

## Crash recovery: pid liveness, not heartbeats/TTLs

A force-quit/`kill -9`/OOM never runs the graceful interrupt path, so a naive reservation would
wedge that project forever. `reserveRun` checks `process.kill(existingPid, 0)` (throws `ESRCH` if
dead) before treating an existing reservation as busy — a dead pid's reservation is reclaimed
instead of blocking. POSIX-only; revisit if Windows packaging is ever added.

## Release is deferred until the delegate CHILD is confirmed dead, not just asked to stop

A second review finding: `interruptAll()`/`cancel()` used to release the reservation as soon as
they *called* `handle.cancel()` (which only sends SIGTERM), not once the child actually exited.
Two problems with that:
- `cancel()`'s confirmation (`onCancelled`) only fires from the delegate's own `close` event
  (see `delegate.ts`) — releasing before that let a *new* run start on the same project while
  the old child (SIGTERM'd, possibly still shutting down or ignoring the signal) was still alive.
- `interruptAll()` is worse: it's called right before the owning process exits, so
  `delegate.ts`'s own SIGKILL-escalation `setTimeout` (5s after SIGTERM) never even gets a
  chance to fire — it's scheduled on an event loop that's about to disappear. A relaunch could
  race a child that's been sent only SIGTERM and might never actually die from it.

Fix: `cancel()` now releases only inside the confirmation callback (delayed, same as before, just
correctly ordered). `interruptAll()` doesn't release *at all* — instead:
- The reservation is created against the *owning* process's pid (nothing else to track before
  the child exists), then `start()` calls `updateReservationPid(dir, projectPath, handle.pid)`
  once the delegate's real child process has spawned (`DelegateHandle` now exposes `pid`).
- `interruptAll()` leaves that reservation in place. The *next* `reserveRun()` for the same
  project checks liveness against the **child's** pid, not the (already-exited) owning process —
  correctly reporting busy for as long as that child is actually running, and reclaiming
  automatically once it's not (same crash-recovery path as an ungraceful exit, just against the
  right pid).

## Everything on the interrupt path is fully synchronous

`RunRegistry.interruptAll()`/`cancel()` and `delegate-tasks.ts`'s equivalents, along with
`run-queue.ts`'s `reserveRun`/`releaseRun`/`updateReservationPid`, are plain synchronous
functions — no `async`, no `Promise` return type. `outbox.ts`'s `enqueueOutbox`/`claimOutbox`
stay `async`-declared for call-site compatibility with existing `await`ers, but are sync
internally (`node:fs`, not `fs/promises`) for the same reason.

Two independent reasons drove this, not just one:
- **Same-process double-start.** `RunRegistry`'s/`delegate-tasks`' settle paths call `releaseRun`
  fire-and-forget from inside a synchronous callback (`onDone`/`onError`/`cancel`'s completion).
  With real `fs/promises`, an unawaited release could still be mid-write when the *very next*
  `start()` call (same process, same tick — this bit a test) ran its busy-check and saw the
  stale-but-not-yet-deleted reservation as "still alive" (same pid).
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

Routines' `delegateStep` (`main.ts`) calls `runDelegate` directly, bypassing both
`RunRegistry`/`delegate-tasks` — it already has its own interruption-adjacent tracking
(`RoutineState.missed`). Not folded into this.

No literal "resume" of a dead detached child (no fd to reattach to) — the reported message just
prompts the user to re-ask.
