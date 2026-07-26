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

## Autostart is intent, not liveness — and it must not weaken the three defenses

`chatops-enabled-store.ts` persists which bots the user switched on (`chatops-enabled.json` in
Electron's userData); `main.ts` replays that list at boot so a quit, a `pnpm dev` relaunch, or an
update install doesn't silently leave the bots off. The set tracks **user intent**, so:

- `start()`/`stop()` (tray *and* Settings both route through `createChatopsServers`) are the only
  things that move a bot in or out — that's why the hook lives in core-app rather than at the two
  call sites.
- **`stopAll()` must never clear it.** It's the quit-time kill from defense 1; clearing it there
  would mean "quit" reads as "the user turned the bots off".
- A crash / non-zero exit also leaves the set alone, so a crashed bot comes back next boot.
- A start that fails the "not built" check enables nothing — it never ran.

Update installs go `app.relaunch()` + `app.exit()`, which **skips `before-quit`** — so defense 2
(`exitWhenOrphaned()`) is what reaps the old servers there, not `stopAll()`. Autostart then spawns
fresh ones. Don't "simplify" the orphan guard away on the theory that `before-quit` covers it.

Because of that, **`installUpdate` in `main.ts` calls `stopAll()` itself** — passed as
`installAndRelaunch`'s `relaunch` hook, not run up front. Relying on the orphan guard there isn't
enough: its poll is 5s, and the replacement app autostarts within that window, so Teams would lose
:3978 to a server that is already doomed. Two writers, one port, and the loser is the one the user
can see. But killing them *before* the bundle swap is wrong too — a failed install leaves the app
running with its bots dead and (since the toggle follows `enabled`) showing Stop, so recovery takes
two clicks for an update that never happened. The `relaunch` hook is reached only after the swap
succeeded, with `exit()` as the next statement; `updater.test.ts` asserts `relaunch` stays
uncalled on every rollback path, which is what makes that placement safe. Keep those tests.

Autostart also retries for the same reason — as the belt to that suspenders. `spawnBot()` retries a
crash up to `MAX_START_ATTEMPTS` (3 total, `RETRY_DELAY_MS` apart), with a fresh budget once a run
has lasted `STABLE_MS`. **`RETRY_DELAY_MS` (5s) is deliberately ≥ the orphan guard's `pollMs`** — a
shorter delay makes all three attempts land inside the window where the orphan can still hold the
port, so the bot gives up over something that would have fixed itself. If you change either
constant, keep that relationship.

**A pending retry is a fourth way to create an orphan** — it can fire after the kill that scheduled
it — so `stopAll()` sets `shuttingDown`, and both the scheduling check and the timer callback test
it plus `enabled.has(bot)`. `start()` clears the flag, so a *failed* update install doesn't leave
retries dead for the rest of the session. Don't drop any of those guards.

**A signal death is a crash, not a clean exit.** Node reports `code === null` when the child was
signalled, so the original `code !== 0 && code !== null` test filed every SIGKILL under "clean" —
leaving the bot enabled, error-free, and offline until someone noticed. The exits we asked for are
identifiable without the code, because we are the only ones who clear `enabled` or set
`shuttingDown`: `const deliberate = shuttingDown || !enabled.has(bot)`, and anything else that
isn't a literal 0 is a crash. Don't reintroduce a code-shaped test for intent.

**`ChatopsState` carries `enabled` alongside `running`, and the Start/Stop toggle follows
`enabled`.** Driving it off `running` (as it originally did) made the intent a one-way door: a
crashed bot showed "Start", so `stop()` was unreachable, so it autostarted every boot with no way
to say no. `stop()` therefore emits even when there's no process to kill — that's the only event
the UI gets on that path.

**When debugging "my chatops change didn't take effect": check the process, not just the code.**
`lsof -nP -iTCP:3978 -sTCP:LISTEN` and `ps -eo pid,lstart,command | grep chatops` — compare the
process start time against when the change landed.
