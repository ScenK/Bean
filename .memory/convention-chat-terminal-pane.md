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
- **Control+` is one capture-phase listener in `ChatWindow`** (routes to the shown chat; skips
  synced chats, repeats, IME). xterm's `attachCustomKeyEventHandler` only stops it sending NUL.
- **Fit only at a real size**: never while folded, hidden, or mid-fold animation (`transitionend`
  on `height` settles it); the shell starts on the first unfold with the fitted cols/rows.
- jsdom (unit tests) has no `ResizeObserver` — the pane guards it rather than a test shim.
- Height is a renderer view pref (`bean.chat.terminalHeight` in localStorage); fold state is never saved.

**Lifecycle (#664).** A live shell (idle or busy) is `hasWork`: a hidden chat holding one stays
mounted, marked in the sidebar by a dim `>_` (not the spinner — a dev server never finishes). An
empty, thread-less chat with a shell can't be kept (no row to come back to), so leaving it goes
through the leave card like an off-the-record chat. "Running" means the tty's foreground process
group isn't the shell's (`foregroundCommand`: `ps -o tpgid=`, then its argv[0] basename) — never
"the shell has a child", which a prompt's gitstatusd or a `cmd &` job makes always true. The close
and leave cards ask main fresh at that moment (`terminalRunning`); an idle shell closes silently.
Terminal output never enters `items`, so it's never saved to `desktop_chats`; a restored chat gets a
fresh, folded terminal.
