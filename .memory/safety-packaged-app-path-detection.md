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
