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
