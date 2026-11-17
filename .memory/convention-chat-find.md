# Find in chat (Cmd/Ctrl+F) is renderer-only

`FindBar.tsx` + `chat-find.ts` (#901): Cmd/Ctrl+F in the chat window's capture-phase keydown opens a
bar that searches only `.bean-chat:not([hidden]) .bean-chat-scroll` — never the sidebar, header,
composer or terminal. No IPC, no Electron `findInPage` (it searches the whole page and auto-opens
`<details>`). Matching is a literal, case-insensitive DOM walk: closed `<details>` bodies,
`.bean-sr-only`, buttons/form controls and `[hidden]` are skipped; block tags split the text so a
match never spans paragraphs. Highlights are `bean-find` / `bean-find-current` (chat-links owns
`bean-link`); colors are `--bean-find-bg` / `--bean-find-current-bg`, held to 4.5:1 under
`--bean-text` by `theme-contrast.test.ts`.

Gotchas: Preact can run a component's unmount effect cleanup *after* its DOM is gone, so `close()`
deletes the highlights itself (the e2e caught them lingering). Any chat list that auto-scrolls
must follow only when near the bottom (ChatPanel, SyncedChat) or it drags the view off a match.
Reveal a match by scrolling each scroll box from the match up to and including the list (wide
table, Steps pane, list), never `scrollIntoView` — it also scrolls `overflow: hidden` ancestors
above the list, so centering a match near the end shoved the window up (blank below).
