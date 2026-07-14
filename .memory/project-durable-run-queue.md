---
name: project-durable-run-queue
description: Cross-process delegate-run reservation (run-queue.ts) split from interrupted-run reporting (outbox.ts reuse); why RunRegistry/delegate-tasks stayed async but sync-internal; the before-quit preventDefault/requeue sequencing in main.ts.
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

## Why `reserveRun`/`releaseRun` use sync fs despite the rest of core using `fs/promises`

`RunRegistry`'s and `delegate-tasks.ts`'s settle paths call `releaseRun` fire-and-forget from
inside a synchronous callback (`onDone`/`onError`/`cancel`'s completion). With `fs/promises`, an
unawaited release could still be mid-write when the *very next* `start()` call (same process, same
tick — this bit a test) ran its busy-check and saw the stale-but-not-yet-deleted reservation as
"still alive" (same pid). Since these are tiny local JSON files and not a hot path, `run-queue.ts`
uses `node:fs` sync calls internally — the exported functions stay `async`-declared for call-site
consistency, but with no internal `await`, the fs work completes synchronously before a
fire-and-forget `void releaseRun(...)` call even returns, so no such race is possible.

## `main.ts`'s before-quit sequencing

Electron does not await async work in a `before-quit` listener unless you `preventDefault()` —
every pre-existing listener in `main.ts` was synchronous fire-and-forget, so marking a delegate
"interrupted" (an outbox write) needed new sequencing:

```ts
app.on("before-quit", (e) => {
  quitting = true;
  if (quitConfirmed) return;
  e.preventDefault();
  void interruptAllDelegates().finally(() => { quitConfirmed = true; app.quit(); });
});
```

The first `before-quit` intercepts and drains delegate-tasks' `interruptAll()`; the second
(self-triggered) `app.quit()` call is let through, and *by then* delegate-tasks' internal state is
already empty — so the **existing** chat window `"closed"` handler's `cancelAllDelegates()` call
needed no changes at all; it just iterates zero entries. Discord/Teams bot subprocesses get the
equivalent via a `process.on("SIGTERM", ...)` handler (they had none before) since
`chatopsServers.stopAll()` kills them with a bare `child.kill()`.

## Explicitly out of scope

Routines' `delegateStep` (`main.ts`) calls `runDelegate` directly, bypassing both
`RunRegistry`/`delegate-tasks` — it already has its own interruption-adjacent tracking
(`RoutineState.missed`). Not folded into this.

No literal "resume" of a dead detached child (no fd to reattach to) — the reported message just
prompts the user to re-ask.
