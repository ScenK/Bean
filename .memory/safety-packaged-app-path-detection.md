# Packaged (Finder-launched) Bean gets a minimal PATH — `detectClis` needs the login shell's real one

`detectClis()` (`packages/core/src/launcher.ts`) scans `process.env.PATH` to find `opencode`/
`claude` for the Plan window's CLI picker. In dev (`pnpm dev`), Electron inherits the launching
terminal's full shell PATH. Packaged and launched via Finder/Dock/Login Items, macOS's `launchd`
gives the process a minimal PATH (roughly `/usr/bin:/bin:/usr/sbin:/sbin`) with none of what a
login shell profile (`.zshrc`/`.zprofile`) adds — nvm, volta, npm/pnpm global bins, `~/.local/bin`,
etc. Since `claude`/`opencode` are commonly installed into exactly those user-profile-managed
locations (not just Homebrew), a hardcoded extra-dirs list (`/opt/homebrew/bin`, `/usr/local/bin`)
catches Homebrew installs but misses the rest — this is why "installed but Bean says it isn't"
only reproduces in the packaged app, never in dev.

Fix: `loginShellPath()` (same file) runs `$SHELL -ilc 'echo -n $PATH'` once via `spawnSync`
(injectable `SpawnSyncFn` for tests, same pattern as `defaultIsExecutable`/`defaultSpawn`) to get
the user's actual resolved PATH, and `main.ts` folds it into the string passed to `detectClis`
alongside `process.env.PATH` and the Homebrew fallbacks. Don't replace this with more hardcoded
directories — the login shell already knows about every tool version manager the user has,
hardcoding can only ever cover the ones we thought of. Verify PATH-detection changes with a real
`pnpm dist:mac` launched from Finder (not `pnpm dev`), same caveat as
[safety-builtin-skills-packaging.md](safety-builtin-skills-packaging.md) — unit tests inject the
shell runner and can't catch a real launchd-environment regression.

**Follow-up bug (fixed):** this PATH fix originally only reached CLI *detection*. The
delegate-spawn path (`core/src/delegate.ts`'s `defaultDelegateSpawn`) spawned `claude`/`opencode`
with no `env` override, so it inherited the packaged app's raw `process.env` — same minimal
launchd PATH — even though `detectClis` had already found the CLI using the login-shell-augmented
PATH. Symptom: "spawn claude ENOENT" when running a delegate task in the packaged app, despite the
CLI showing as available. Fix: `main.ts` names the merged PATH string (`resolvedPath`) instead of
building it inline, and passes it to `createDelegateTasks({ resolvedPath, ... })`;
`delegate-tasks.ts` uses it to build a `spawnFn` with `env: { ...process.env, PATH: resolvedPath }`
and threads that into `runDelegate(...)`. If you add another child-process spawn path for a CLI
tool, it needs this same `resolvedPath` threaded in — `detectClis` finding a CLI does not mean a
bare `spawn()` elsewhere will find it too.

**Second follow-up bug (fixed):** the 2a "no project" URL-seed flow hit the exact same class of
bug for `git`, not a Bean CLI. `sniffUrl()`'s `git ls-remote` probe (`core/src/url-sniff.ts`) and
`prepareScratchWorkspace()`'s `git clone` (`core/src/scratch-workspace.ts`) both spawned `git`
with no `env` override, so a Finder-launched build with `git` only on a login-shell-managed PATH
(e.g. Homebrew) could misclassify a repo URL as a page (ls-remote silently fails, falls through
to the HEAD/page check) or fail the clone outright — despite `detectClis`/delegate spawning
already working correctly for the same reason this file exists. Fix: both files now export a
`make*` factory (`makeGitLsRemote(env)`, `makeScratchSpawn(env)`) instead of a bare
env-less default, and `main.ts` builds both from the same `resolvedPath`-augmented env used for
`delegateTasks` and passes them into `registerIpc` via the already-existing `sniffUrl`/
`prepareScratchWorkspace` injection points in `ipc.ts`. Same rule applies: any new `git`/CLI
child-process spawn needs `resolvedPath` threaded in explicitly — it's never inherited for free.
Unit tests inject fakes for `GitLsRemoteFn`/`ScratchSpawnFn` (they always have, even before this
fix) and can't catch a missing `env`, same real-`pnpm dist:mac`-required caveat as above.
