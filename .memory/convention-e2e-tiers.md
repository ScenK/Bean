# Desktop e2e runs in two tiers: `@ci` on pull requests, full suite locally and on main

Every e2e test launches a whole Electron app, so the suite's cost grows with each spec. It is split:

- **`test:e2e:ci`** (`playwright test --grep @ci`) — the tests tagged `{ tag: "@ci" }`. Pull-request
  CI runs only these. At most **10** tests carry the tag; adding one means untagging another.
  Keep the set on boot, crash recovery, chat round trip, abort, history restore, contrast,
  delegate spawn, and terminal teardown — the paths whose break hurts most.
- **`test:e2e`** — everything. Run it locally for every `packages/app/` diff (the AGENTS.md
  gate). Pull-request CI does not, so the local run is the only full check before merge.
  Pushes to `main` run it in CI.

Rules:

- Add an e2e spec only for what vitest cannot see: real windows, IPC/preload, rendered CSS,
  process effects, or a restart. Everything else goes in `__test__/`. New tests are untagged.
- A spec your diff cannot reach fails: re-run it alone. If it also fails on `main`, report it
  as a flake and don't fix it in that PR.
- A red full run on `main` is fixed or reverted by the next `packages/app/` task.
- **No retries** (`retries` stays unset in `playwright.config.ts`): the avatar startup race
  ([project-e2e-ipc-ready-race.md](project-e2e-ipc-ready-race.md)) first looked like a flake
  and was a real bug.
