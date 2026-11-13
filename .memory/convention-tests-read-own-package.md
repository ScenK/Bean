# A test reads only its own package's files (or its workspace deps')

Turbo hashes a package's `test` task from that package's files plus its workspace deps (`^build`).
A test that reads another package's source or assets (`../../app/src/main.ts`, `../../teams/…`)
replays a **cached pass** locally when only that other file changes — #826 went red in CI only.

- Put the assertion in the package that owns the file: the app's update relaunch is checked in
  `packages/app/__test__/live-teardown.test.ts`, the Teams manifest in
  `packages/teams/__test__/manifest.test.ts`, and the "no `...process.env` spread" scan is one
  `spawn-env.test.ts` per package, each scanning its own `src/`.
- Reading a dep is fine (app → host/core; host, discord, teams → core): a dep change re-hashes.
- No `inputs` in `turbo.json` for this — keep the rule, not a cross-package hash list.
- Gate a suspicious change with `pnpm exec turbo run test typecheck --force`.
