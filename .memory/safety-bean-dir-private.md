# safety: `~/.bean` must stay 0700

`~/.bean` holds `config.json` (OpenAI key), `bean.db` (memories, chat history), routines, outbox.
macOS standard users share the `staff` group and home folders are `drwxr-x---`, so a second
account on the Mac can traverse into `~` — and with a default `drwxr-xr-x` `~/.bean`, read
everything inside.

- `ensurePrivateBeanDir(dir)` (`core/src/config.ts`) does `mkdirSync(..., { mode: 0o700 })` then
  `chmodSync(0o700)` — the chmod is load-bearing: mkdir's mode is umask-masked and ignored for an
  existing directory, so it is what fixes installs made before #455.
- Called once at startup, **before the first `~/.bean` access**, in all three surfaces:
  `app/src/main.ts` (top of `whenReady`, before `mkdirSync(scratchDir)`), `discord/src/server.ts`
  and `teams/src/server.ts` (right after `const dir = beanDir()`). A new surface/entry point
  needs the same call.
- Directory mode only, on purpose: a 0700 dir blocks traversal to every file inside (WAL
  sidecars, outbox, routines), so per-file modes aren't needed. Don't loosen the dir to fix an
  access problem — a second account gets its own `~/.bean`.
