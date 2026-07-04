# safety: dev orchestrator children must NOT be detached

`packages/app/scripts/dev.mjs` spawns three long-lived children (core `tsc --watch`,
`esbuild --watch`, Electron). They are spawned **without** `detached` on purpose. Do **not**
add `detached: true` back.

**Why it broke before:** the children were once spawned `detached: process.platform !== "win32"`,
each in its own process group, and `dev-processes.mjs`'s `killAll()` group-killed them
(`process.kill(-pid, "SIGTERM")`) from `dev.mjs`'s `SIGINT`/`SIGTERM` handler. Under
`pnpm dev`, Ctrl+C sends `SIGINT` to the whole foreground process group — but the detached
children are in *their own* groups, so the terminal's Ctrl+C never reaches them. Their only
hope was `dev.mjs`'s handler, and **that handler never runs**: pnpm (the parent chain) tears
`node dev.mjs` down before its JS signal handler fires. Net result: press Ctrl+C, the Electron
app (plus esbuild/tsc watchers) stays alive, orphaned to PID 1.

**The fix / current design:** leave children in `dev.mjs`'s own process group (no `detached`).
Ctrl+C's group-wide `SIGINT` then reaches tsc, esbuild, and Electron **directly** — each dies
on its own (Electron reaps its own helpers), with zero dependence on the fragile handler.
`killAll()` is now only a best-effort reap for abnormal exits (per-child `child.kill()`,
SIGTERM), not the Ctrl+C path.

Verified by launching real `pnpm dev` in its own session and sending `SIGINT` to the group
(mimicking Ctrl+C): zero survivors. Detaching again reproduces the orphan.
