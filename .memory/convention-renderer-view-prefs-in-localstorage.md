# Renderer-only view preferences live in localStorage

A UI-shape preference that nothing outside the window needs — which notes groups are folded,
a remembered tab, a collapsed section — is stored by the renderer in `localStorage`, not
through an IPC channel into `~/.bean`. First user: `NotesPanel`'s `bean.notes.collapsedGroups`.

This works: Bean's component windows load over `file://` (`win.loadFile`), and Electron gives
those pages real, per-`userData` localStorage that **survives an app restart** — verified by
`packages/app/e2e/notes-fold.e2e.ts`, which folds a group, relaunches the app against the same
`--user-data-dir`, and asserts it is still folded. That's also why `launchBean()` takes an
optional `reuseUserDataDir`.

Key the stored value by something stable and unique — `NotesPanel` stores project *paths*
(`""` for General), not display names: names repeat, get renamed, and a project may literally
be called "General", all of which would fold the wrong group.

Wrap every read and write in try/catch and render correctly with the value missing — a failed
read just means nothing is folded. Anything that must reach main, another surface, or the user's
own config still goes through an IPC channel and `~/.bean` (see `theme-store.ts` for that shape).
