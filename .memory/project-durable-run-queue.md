---
name: project-durable-run-queue
description: Cross-process delegate-run reservation (run-queue.ts) split from interrupted-run reporting (outbox.ts reuse); why interruptAll()/enqueueOutbox/releaseRun are all fully synchronous, and why main.ts's before-quit does NOT use preventDefault.
metadata:
  type: project
---

Desktop chat (`delegate-tasks.ts`) and the Discord/Teams bots (`RunRegistry`, one instance per
bot **process**) each only enforced "one delegate run per project path" within their own process.
Nothing stopped the same project being delegated to from two surfaces at once, and quitting
mid-run just killed the child and forgot about it.

## Reservation vs. reporting — deliberately two different mechanisms

- **Reservation** ("is project X already claimed?") — `packages/core/src/run-queue.ts`,
  `reserveRun`/`releaseRun`, one JSON file per active run under `~/.bean/runs/<id>.json`
  (`{ id, projectPath, pid, createdAt }` — nothing else). Checked as a *second*, cross-process
  layer after each caller's own existing synchronous in-memory guard (`RunRegistry.byProject`,
  delegate-tasks' in-memory task map) — the in-memory check is still what prevents same-process,
  same-tick double-starts; the disk check only extends that invariant across processes.
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

## Everything on the interrupt path is fully synchronous — `reserveRun`/`releaseRun`/`enqueueOutbox`

`RunRegistry.interruptAll()` and `delegate-tasks.ts`'s `interruptAll()` are plain synchronous
functions (not `async`), and so are `outbox.ts`'s `enqueueOutbox`/`claimOutbox` and
`run-queue.ts`'s `reserveRun`/`releaseRun` under the hood — all use `node:fs` sync calls
(`readFileSync`/`writeFileSync`/`rmSync`/etc.) instead of `fs/promises`. `enqueueOutbox`/
`reserveRun`/`releaseRun` stay `async`-declared (return a `Promise`) purely for call-site
compatibility with existing `await`ers elsewhere (e.g. `RunRegistry.start()`'s cross-process
busy-check genuinely wants to await); with no internal `await`, calling one without awaiting
still runs its fs work to completion before the call returns.

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
