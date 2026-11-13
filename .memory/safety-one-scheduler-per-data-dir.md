# One scheduler per data directory (bean.db lease)

The sprout scheduler and the reminder loop run only in the process holding the `scheduler` row of
`bean.db`'s `leases` table (`core/src/scheduler-lease.ts`, #800). A pid file can't do this:
`bean-core` may run in a Docker container on a shared volume. Heartbeat 30s, TTL 90s; the claim
is an UPSERT (modeled on the dream lease) plus its read-back inside one `BEGIN IMMEDIATE` — a
separate SELECT could see the holder's release and read "no row" as acquired. Wall-clock epoch ms.
Only an explicit `onAcquired` means held: a db error on a claim fires neither callback.

Desktop and `bean-core` share one lease + scheduler wiring in `@bean/host`'s `createHost()`
(`host.ts`), built on core's `createRoutineWiring` (its `start()` = recover todos, then start if
`canSchedule()`) and `startReminderLoop` (`routine-wiring.ts`); only `deps.headless` differs. Holder-only work: the scheduler, reminders, and `recoverInterruptedTodos` (a standby process would
fail the holder's live `running` todos). Gate on `lease.held()`, not a flag: it fails closed at the
last good renewal's expiry even while heartbeats error (then `onLost(undefined)`). `canSchedule` is
re-checked after `tick()`'s awaits and inside automatic watch polls before every side effect (todo,
notify delivery — also after its history save —, seen-mark, state). A lost poll drops its results
so the new holder re-offers them.

- **Desktop** (`createHost` without `headless`): refused → standby + a sticky "Sprouts and reminders paused" bubble, takes
  over (recover todos, then start) when the holder releases or expires. Lost (Mac slept past the TTL and the bot took it) →
  scheduler stopped, bubble says relaunch. The update relaunch skips before-quit, so `main.ts`'s
  `stopCore` releases the lease explicitly — keep that.
- **`bean-core`** (`createHost` with `headless`, #806): same standby as desktop (the status error is
  a log line), so a restart loop under systemd/launchd can't happen. Lost → `onLeaseLost` → quit
  hooks + exit 1; the service manager restarts it into standby. Boot cleanup is `sweepDeadRuns`
  (never kills), so it's safe before the lease.
- `createHost` passes `canSchedule: schedulerLease.held` to the scheduler: a standby app's manual Run-now
  still runs that one sprout, but its follow-up `tick()` (watch re-check, Check now) fires nothing.
- The Electron single-instance lock is separate and unchanged.
