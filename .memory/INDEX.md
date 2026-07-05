# Team Memory — Index

> **Cross-tool, committed memory.** Read this at session start; follow links to entries
> relevant to your task. `safety-*` entries are load-bearing — they document things that
> have broken before. If an entry contradicts the code, **trust the code and fix the entry
> in the same change.**
>
> Add an entry when you learn something the next agent should know. Keep entries short
> (a paragraph or two), kebab-case filenames, prefixed by category. This is the **team**
> layer — never put personal preferences here (those go in your tool's own memory store).

## safety — things that broke before, don't undo

- [safety-preload-must-be-cjs.md](safety-preload-must-be-cjs.md) — why the Electron preload is built as `.cjs` and guarded against ESM syntax.
- [safety-window-behavior.md](safety-window-behavior.md) — avatar/intake share one window; the no-drag click target, console respawn, and don't-quit-on-avatar-close rules.
- [safety-dev-children-not-detached.md](safety-dev-children-not-detached.md) — `pnpm dev`'s watch/Electron children must stay in the orchestrator's process group (no `detached`) so Ctrl+C reaches them; detaching orphans the Electron app on quit.
- [safety-single-instance-lock-and-dev-relaunch.md](safety-single-instance-lock-and-dev-relaunch.md) — dev relaunch must wait for the old Electron's exit (single-instance lock race), main.ts handles SIGINT/SIGTERM itself, and lock failure uses `app.exit` not `app.quit`.
- [safety-skill-frontmatter-and-prompt-flag.md](safety-skill-frontmatter-and-prompt-flag.md) — skill frontmatter is stripped from composed prompts, opencode gets `--prompt=` as one token, and the Skills editor requires `target:` at save time (never auto-inserted) — a `---`-leading prompt used to launch opencode with no prompt.
- [safety-builtin-skills-packaging.md](safety-builtin-skills-packaging.md) — `projectBeanDir()`'s path walk only works in dev; packaged builds need `.bean` copied via electron-builder `extraResources` and `main.ts` to switch on `app.isPackaged`. Verify with a real `pnpm dist:mac`, not just tests.
- [safety-drag-mode-needs-watchdog.md](safety-drag-mode-needs-watchdog.md) — the drag-skill bloom wedged the avatar (looked like a full app freeze) when drop/dragleave never arrived; the watchdog + collapse-race + escape-hatch guards that fix it.
- [safety-packaged-app-path-detection.md](safety-packaged-app-path-detection.md) — Finder-launched Bean gets launchd's minimal PATH, so `detectClis` misses CLIs installed via nvm/volta/pnpm/`~/.local/bin`; `loginShellPath()` asks the real login shell instead of hardcoding more directories.

## convention — how we do things here

- [convention-ipc-channels.md](convention-ipc-channels.md) — IPC channel names are defined once in `app/src/channels.ts`; never string-literal them.
- [convention-core-is-electron-free.md](convention-core-is-electron-free.md) — keep `@bean/core` pure and dependency-injected so it tests without Electron.
- [convention-renderer-imports-node-free-subpaths.md](convention-renderer-imports-node-free-subpaths.md) — renderer imports core *values* only from node-free subpaths (`@bean/core/prompt|project-select|frontmatter`), never the barrel (pulls `node:fs` into the browser bundle); type-only barrel imports are fine. Fails only at `pnpm dev`/`build`, not test/typecheck.
- [convention-launch-hands-off-to-terminal.md](convention-launch-hands-off-to-terminal.md) — Bean is a pure trigger: `launchInTerminal()` hands a run off to Terminal.app (`.command` script + `open`) fire-and-forget; it doesn't spawn/stream/track the process itself. Obsoletes the old stdin-hang note and the task-status-tracking UI.
- [convention-action-tools.md](convention-action-tools.md) — action tools (execute-in-main, tool loop in `converse()`) vs confirm-first `propose_run`; reminders + `fetch_url` are the first; also covers `target: chat` skills that run in Bean's chat instead of the terminal.
- [convention-project-skills-vs-default-skill.md](convention-project-skills-vs-default-skill.md) — `Project.skills` (many-to-many skill-group assignment, powers the Skills panel's General/project grouping) vs `Project.defaultSkill` (unrelated router/drop-plan/avatar fallback heuristic) — don't conflate them, and don't drop `skills` when rebuilding a `Project` object from an edit form.

## project — ongoing work context

- [project-settings-about-context-menu.md](project-settings-about-context-menu.md) — Settings/Persona/About/Exit live only behind the tray's left-click (no right-click anywhere, on tray or avatar); live-reloading Settings over ~/.bean via runtime-config, and the no-fake-chrome window rule (match the chat window; register new windows in esbuild + windows.ts).
- [project-notes-feature.md](project-notes-feature.md) — Notes (chat ⇄ note): confirm-first `propose_note`, `~/.bean/notes/*.md` with versions in `.history/`, linked-chat update-in-place rule, and why notes must stay explicit/inert vs memory.
- [project-bean-memory.md](project-bean-memory.md) — Bean's memory: `~/.bean/memory.json`, extract-on-close (confirm), recall-into-converse, enabled-skill filter, persona-panel editing.
