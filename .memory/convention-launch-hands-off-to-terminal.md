# convention: Bean hands runs off to Terminal, it doesn't run them itself

Bean no longer spawns `opencode`/`claude` as a child process it owns, streams stdout/stderr
from, or tracks status/pid/exit-code for. `launchInTerminal()` (`packages/core/src/launcher.ts`)
writes a temp `.command` script (`cd <projectPath> && <command> <args>`, args shell-quoted via
`shQuote`) and does `open <script>` — the same mechanism as double-clicking a `.command` file in
Finder — which launches Terminal.app and runs it. `open` (zed) mode is a GUI app, so it's spawned
directly, no script. Either way the call is fire-and-forget: no `onEvent`, no taskId, no cancel,
no return value.

**Why:** the previous design (`runOpencode()` in a now-deleted `runner.ts`, plus a parallel
`launchTask()`/`TaskEvent` status-tracking path in `launcher.ts`) had Bean itself own the process,
piping stdio back into an in-app console/task-list UI. That meant real `~/.bean` skills only ever
ran through Bean-managed pipes — the opposite of the goal: a **centralized skill library** that
any harness (a real terminal, a different tool) can point at. Handing off to the OS terminal
turns Bean into a pure trigger: it picks the skill + project + composes the prompt, the user
watches/interacts with the actual CLI directly.

**What this obsoletes:**
- The old `safety-runopencode-stdin-hang.md` note (child's stdin must be closed or a piped
  `opencode run` hangs) — moot now: `opencode`/`claude` run inside Terminal.app's own real tty,
  not a Node-spawned pipe.
- `TaskCard`/`TaskMonitor`/`onTaskEvent`/`cancelTask` (deleted from `app/`) — nothing to track
  once the process isn't Bean's child.
- `ConsolePanel.tsx` + `core/src/terminal.ts` (ANSI-to-styled-lines parser, `anser` dependency) —
  both were already-orphaned, never wired up; deleted rather than left dead.

**If a prompt needs escaping:** `shQuote()` single-quotes each arg (`'...'`, escaping an embedded
`'` as `'\''`), which round-trips arbitrary multi-line prompt text (skill body + instruction +
dropped URL) losslessly into the generated shell script — verified in
`packages/core/__test__/launcher.test.ts`.

**Still true, unchanged:** the frontmatter/flag-misparsing risk noted in the old runner
ponytail comment (a prompt starting with `-`/`--` could be misread by `opencode`'s yargs CLI as
a flag) — carried forward verbatim into `launchCommand()`'s comment. Not yet fixed at the source.

**Scope update:** this convention covers Terminal launches (`launchInTerminal`) only. The
delegate subsystem ([convention-delegate-loopback](convention-delegate-loopback.md)) is the
deliberate exception: headless runs that Bean spawns, streams, and tracks. Don't merge the
two paths — the launcher stays fire-and-forget.
