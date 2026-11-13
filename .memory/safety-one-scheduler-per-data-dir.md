# One scheduler per data directory (bean.db lease)

The sprout scheduler and the reminder loop run only in the process holding the `scheduler` row of
`bean.db`'s `leases` table (`core/src/scheduler-lease.ts`, #800). A pid file can't do this: the
headless bot may run in a Docker container on a shared volume. Heartbeat 30s, TTL 90s; claim is one
atomic UPSERT (modeled on the dream lease), wall-clock epoch ms.

- **Desktop** (`main.ts`): refused → standby + a sticky "Sprouts and reminders paused" bubble, takes
  over when the holder releases or expires. Lost (Mac slept past the TTL and the bot took it) →
  scheduler stopped, bubble says relaunch. The update relaunch skips before-quit, so it releases
  the lease explicitly — keep that.
- **Headless bot** (`headless-routines.ts`): the lease is taken **before** boot cleanup
  (`clearReservations` would kill the holder's runs); refused/lost → one log line, exit 1. Released
  last in shutdown.
- Desktop passes `canSchedule: () => leaseHeld` to the scheduler: a standby app's manual Run-now
  still runs that one sprout, but its follow-up `tick()` (watch re-check, Check now) fires nothing.
- The Electron single-instance lock is separate and unchanged.
