# One scheduler per data directory (bean.db lease)

The sprout scheduler and the reminder loop run only in the process holding the `scheduler` row of
`bean.db`'s `leases` table (`core/src/scheduler-lease.ts`, #800). A pid file can't do this: the
headless bot may run in a Docker container on a shared volume. Heartbeat 30s, TTL 90s; the claim
is an UPSERT (modeled on the dream lease) plus its read-back inside one `BEGIN IMMEDIATE` — a
separate SELECT could see the holder's release and read "no row" as acquired. Wall-clock epoch ms.
Only an explicit `onAcquired` means held: a db error on a claim fires neither callback.

Holder-only work: the scheduler, reminders, and `recoverInterruptedTodos` (a standby process would
fail the holder's live `running` todos). `canSchedule` is re-checked after `tick()`'s awaits.

- **Desktop** (`main.ts`): refused → standby + a sticky "Sprouts and reminders paused" bubble, takes
  over (recover todos, then start) when the holder releases or expires. Lost (Mac slept past the TTL and the bot took it) →
  scheduler stopped, bubble says relaunch. The update relaunch skips before-quit, so it releases
  the lease explicitly — keep that.
- **Headless bot** (`headless-routines.ts`): the lease is taken **before** boot cleanup
  (`clearReservations` would kill the holder's runs); refused/claim error/lost → one log line, exit 1. Released
  last in shutdown.
- Desktop passes `canSchedule: () => leaseHeld` to the scheduler: a standby app's manual Run-now
  still runs that one sprout, but its follow-up `tick()` (watch re-check, Check now) fires nothing.
- The Electron single-instance lock is separate and unchanged.
