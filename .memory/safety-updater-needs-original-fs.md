# safety: updater bundle fs ops must use `original-fs`, not `node:fs`

Electron's main process patches `fs` so any `*.asar` path behaves like a read-only virtual
directory. A recursive `rm`/`cp` over an app bundle therefore walks *into*
`Contents/Resources/app.asar`, fails on its virtual entries, and the swallowed error left a
`Bean.app.old` skeleton (just the `app.asar` chain) in `/Applications` after every
auto-update, plus leaked `bean-update-*` temp dirs (one full ~427MB copy observed). Two
prior fixes (#55, #63) reshuffled the rename/rm dance but never fixed this root cause,
because the failure only exists under Electron — plain-node unit tests always pass.

Fix: `updater.ts`'s `bundleFs()` resolves Electron's unpatched `original-fs` via
`createRequire` (falls back to `node:fs/promises` under vitest) and all default
`rename`/`cp`/`rm` deps go through it. Don't revert these to bare `node:fs` imports.

Verify under real Electron, not vitest: run a script via `./node_modules/.bin/electron`
that `fs.rm`s a dir containing an `app.asar` — patched fs fails ENOTEMPTY, `original-fs`
succeeds.
