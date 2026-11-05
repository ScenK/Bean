# Chat terminal pane (renderer side of the per-chat terminal)

`TerminalPane.tsx` is the xterm view of the shell `terminal-tasks.ts` owns (see
[safety-node-pty-terminal-host.md](safety-node-pty-terminal-host.md)). What isn't obvious:

- **Colors go through a canvas.** Theme tokens are `oklch()` and `getComputedStyle` returns them
  verbatim; xterm needs RGB, so `terminalTheme()` resolves each token through a 1×1 canvas. A theme
  flip re-applies via a `data-theme` MutationObserver per pane (hidden chats' panes too).
- **ANSI palette is 16 `--bean-ansi-*` tokens per theme**, each 4.5:1 on `--bean-surface` (the
  pane's only backdrop), guarded by `theme-contrast.test.ts`. Light theme's "white" is a gray and
  dark theme's "black" is a gray on purpose. `minimumContrastRatio: 4.5` covers 256/truecolor.
- **`xterm.css` is copied, not bundled** (`esbuild.config.mjs`), linked only from `chat.html`.
  It paints `.xterm-viewport` `#000` — `shared.css` overrides it to transparent; drop that and a
  black strip shows under the last row.
- **Control+` and the tab shortcuts are one capture-phase listener in `ChatWindow`** (routes to the
  shown chat; skips synced chats, repeats, IME): Cmd+T, Cmd+1…4, Cmd+Shift+[ / ] by `e.code`
  (`tabShortcut`). Cmd+W stays Electron's Close Window; Control+T/W stay readline's. xterm's
  `attachCustomKeyEventHandler` only keeps xterm off them.
- **Fit only at a real size**: never while folded, hidden, or mid-fold animation (`transitionend`
  on `height` settles it); the shell starts on the first unfold with the fitted cols/rows.
- jsdom (unit tests) has no `ResizeObserver` — the pane guards it rather than a test shim.
- Height is a renderer view pref (`bean.chat.terminalHeight` in localStorage); fold state is never saved.

**Lifecycle (#664).** A live shell (idle or busy) is `hasWork`: a hidden chat holding one stays
mounted, marked in the sidebar by a dim `>_` (not the spinner — a dev server never finishes). An
empty, thread-less chat with a shell can't be kept (no row to come back to), so leaving it goes
through the leave card like an off-the-record chat. "Running" means the tty's foreground process
group isn't the shell's (`foregroundCommands`: `ps -o pid=,tpgid=`, then the groups' argv[0]
basenames, sanitized) — never "the shell has a child", which a prompt's gitstatusd or a `cmd &` job
makes always true. The close
and leave cards ask main fresh at that moment (`terminalRunning`, one command per busy tab); an idle
shell closes silently. Each command counts as a task (#675): one chat's terminals alone are named
("npm and vim", then "npm, vim + 1 more" — `commandList`); mixed with other work or across several
chats the card falls back to "Closing stops N tasks in M chats."
Terminal output never enters `items`, so it's never saved to `desktop_chats`; a restored chat gets a
fresh, folded terminal.

**Tabs (#673).** Main keys terminals mount → tab (renderer-made UUID), at most `MAX_TABS` (4) per
chat, the cap checked in the same synchronous section that reserves the slot. Every terminal IPC
call carries the tab; `terminalStop` with no tab (and release) stops the whole mount. One
registry-wide busy poll (two `ps` calls per tick for all shells, skipped while one is in flight,
off when no shell lives) pushes `busy` with the command name on change — never a timer per tab.

**Tab strip (#674).** One xterm per tab, opened into its host the first time the tab is shown (it
needs a real size); hidden tabs keep writing and acking, so a background dev server never stalls on
flow control. Focus moves to a new shell only after `terminalStart` resolves (main drops keys for a
tab it doesn't have yet). Exit code 0 closes the tab; non-zero or a signal keeps it with Restart. A
bare `exit` reuses `$?` — a fresh-HOME zsh (e2e) leaves it at 1, so specs type `exit 0`. Closing
the last tab folds the pane; the next unfold opens a fresh one. `ChatSession` counts live tabs
(`onShells`) — any one keeps a hidden chat mounted. The idle title is the shell's name from the
start result (`shell`), the busy one main's `command`.
