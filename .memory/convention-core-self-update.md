# Core self-update: prepare, latch, busy, flip, exit

`packages/host/src/core-update.ts` (#837) is the one update path for an installed `bean-core`
(`bean-core update [--yes]` now, the shell's remote ops in #838). Keep the order:

1. **Prepare, touching nothing running:** fixed `releases/latest` → bounded download of
   `bean-core-<ver>.tar.gz` + `.sig` → Ed25519 verify (hard stop) → unpack to
   `versions/<ver>` → preflight `node <new>/…/bean-core.js --version` (`checkCorePreflight`).
2. **Latch** (`host.coreUpdate.close()`): new chat turns, delegates, live sessions/resumes,
   sprout Run now / bot triggers, builder agents are refused with `UPDATING`; `canSchedule` is false.
3. **Busy check** (`busyWork`): running `taskStatus` jobs + live `~/.bean/runs/` records (bots)
   + sprouts holding a scheduler slot (`runningNames()`: taken synchronously in `fill()`, before
   the bubble) + starts admitted before the latch but still in their async checks (host `track()`: delegate /
   live starts, Run now, bot triggers, builder agents). A new start path must go through `track`,
   or a latch closed in its gap reads idle.
   Busy and not forced → reopen the latch, return the list. Any failure also reopens it.
4. **Flip** `previous` ← `current` ← `versions/<new>` (temp link + rename), answer, then `shutdown(0)`;
   launchd `KeepAlive` / systemd `Restart=always` start the new version. The latch stays closed.

No drain queue ("update when idle"): refuse or force is the whole policy; a forced update's quit
hooks interrupt runs, which leave their usual outbox notice. Known gap: a bot's in-flight chat
turn lives in the bot process, isn't latched or counted, and is lost if the update lands then.

`bean-core update` speaks to the running core with a first frame `{type:"update", force}` on
`core.sock` (no attachment, so a connected shell isn't displaced). A required contract is checked
only when the caller passes one (a shell must reattach); the box's own update accepts any contract —
it's the recovery when a shell can't attach (the mismatch banner offers `ssh <host> bean-core update --yes`).

A shell updates through two zero-argument remote ops (#838): `coreUpdateStatus` (`coreUpdateStatus()`:
release check only, labels via `busyLabel`) and `coreUpdateApply(force)` (contract pinned to the shell's;
`serveConnection` flushes the "updated" reply, then `onUpdated` exits). About (`about/CoreUpdate.tsx`) shows
them only for a remote core and decides success from the **reattached handshake's** version, not the
reply; no reattach in `CORE_RETURN_MS` (2 min) → the rollback command. An older core refuses the ops
as "… is not allowed over a remote attach" — that string is how About says "predates remote update". No core listening → it updates in-process and runs
`current/install.sh --restart`. Rollback stays install.sh's (`bean-core rollback`), which is why
`bean.db` migrations must stay additive ([convention-bean-db-column-additions.md](convention-bean-db-column-additions.md)).
