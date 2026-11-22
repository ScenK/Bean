# Desktop e2e: who runs what, quarantine, and the suite budget

Every e2e test launches a whole Electron app, so the suite costs minutes and its flakes cost turns.
Each rule below is enforced by a script, not by an agent remembering it.

Who runs the suite:

- **Bean e2e gate** (`~/.bean/scripts/bean-e2e-gate.sh`, the `e2e` step of the Bean Autonomous Dev
  sprout) — the full suite, once per issue that touches `packages/app/`, after review passes. A red
  run retries only the failed specs once; red twice goes back to `implement`. Each issue's worktree
  holds its stack parent's commits, so a parent's real break is stopped at the parent's own gate
  before any child is built on it.
- **Pull-request CI** — `test:e2e:ci` (`--grep @ci`): at most **10** tagged tests on boot, crash
  recovery, chat round trip, abort, history restore, contrast, delegate spawn, terminal teardown.
  Adding a tag means removing one.
- **Main-push CI** — the full suite on a clean runner. A red run blocks nobody and is not the next
  task's job: it is the **E2E Patrol** sprout's input.
- **Dev sessions** — never the full suite; optionally the specs covering the diff.

Quarantine (`packages/app/e2e/quarantine.json`, read by `playwright.config.ts` as `grepInvert` on
file + exact title — never a substring):

- E2E Patrol (`~/.bean/scripts/bean-e2e-patrol.py`) adds a test that failed twice in 7 days
  (main CI, or a gate run that passed on retry) via a PR, and opens a `Flaky e2e: <title>` issue
  in Backlog. A test failing on the two latest main runs is a real break: a `Main e2e red:` issue
  goes to Ready instead, no quarantine.
- Fixing one = removing its entry, then `playwright test e2e/<file> -g "<title>" --repeat-each=10`
  green. Still listed after 14 days → the patrol moves its issue to Ready to delete the test.
- A flake that passes alone usually passes `--repeat-each` too. Reproduce it under CPU load
  (`yes > /dev/null` × `sysctl -n hw.ncpu`, plus `--trace=retain-on-failure`); the trace's one
  call without an `after` event is the stalled step. A bare `Test timeout` = a click or wait with no
  timeout of its own. Seen (#1020): a `/skill` sent before the new mount's skill catalog loaded
  goes to Bean as plain text, so no card. Wait for the `/` menu to list the skill first.
  Seen (#1043): a bare `openComponent("chat")` opens Home — the window first mounts a blank chat,
  then switches to Home when `getPendingChatHome` answers, evicting that mount. A drop/fill before
  the switch is lost. Wait for `.bean-chat-sidebar-home--active` before the first composer action.
- No `retries` in `playwright.config.ts`: the avatar startup race
  ([project-e2e-ipc-ready-race.md](project-e2e-ipc-ready-race.md)) looked like a flake and was a
  real bug — quarantine keeps that signal as an issue instead of hiding it.

Budget: the gate fails when `playwright test --list` counts more than the cap in
`bean-e2e-gate.sh` (90). Over it, merge the new assertions into an existing test or delete a
low-value one. Add an e2e test only for what vitest cannot see: real windows, IPC/preload,
rendered CSS, process effects, or a restart.
