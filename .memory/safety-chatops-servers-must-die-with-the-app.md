# Chatops servers must die with the app — orphans serve stale code forever

A spawned chatops server (`chatops-servers.ts` → `packages/*/dist/server.js`) does **not** die
when the desktop app exits. Left alone it is reparented to launchd, keeps port 3978, and keeps
answering Teams/Discord webhooks with **whatever build it booted with** — indefinitely.

This actually happened: three Teams servers were running from three different days; the oldest
(pre-dating a merged behavior change by two days) owned the port, so a correctly-shipped,
correctly-built, correctly-installed change looked like it had never landed. Everything on disk
was right; only the process was stale. Debugging cost hours because the tray still said
"running".

Three defenses, all load-bearing — don't remove any of them:

1. **`main.ts`'s `before-quit` calls `chatopsServers.stopAll()`.** `stopAll()` existed for ages
   but nothing called it, which is how the orphans accumulated in the first place. A method
   that is never called is not a defense.
2. **`exitWhenOrphaned()`** (`core/src/chatops/orphan-guard.ts`) runs inside each server and
   exits when `process.ppid` changes. This covers what `before-quit` cannot: crash, force-quit,
   SIGKILL. Discord needs it as much as Teams — it binds no port, so a stale Discord orphan
   never announces itself with EADDRINUSE, it just silently answers alongside the new one.
3. **Teams surfaces `EADDRINUSE` and exits 1**, so a port clash shows as a tray error instead
   of a false "running" state.

**Node quirk worth knowing** (it's why the log was lying): `app.listen(port, cb)` fires `cb`
**even when the bind is about to fail** — "listening" is emitted first, then "error". Logging
success synchronously inside that callback prints "listening on :3978" from a process that is
about to exit. The success log is therefore deferred with `setImmediate` and guarded by a
`bindFailed` flag; the error reliably lands first (verified empirically).

**When debugging "my chatops change didn't take effect": check the process, not just the code.**
`lsof -nP -iTCP:3978 -sTCP:LISTEN` and `ps -eo pid,lstart,command | grep chatops` — compare the
process start time against when the change landed.
