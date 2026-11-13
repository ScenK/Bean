# Cmd+click paths in the chat log: main decides, packages reveal-only

Desktop chat Cmd+click (#779): `renderer/components/chat/chat-links.ts` finds the URL/path token
under the pointer at click time (no Markdown rewriting; inline `<code>` = its whole text); URLs go
to `terminalOpenLink`, paths to `chatOpenPath`. The printed text is untrusted model/CLI output, so:

- **All validation is in main** (`app/src/chat-open-path.ts`): sender must own the mount, length
  cap, no control chars, no URI scheme, only `~/` expands, `:line[:col]` stripped, missing = no-op.
  The renderer never supplies a working directory — a relative path resolves only against
  the host's `liveProjectOf(mount)` (`host/src/live-tasks.ts` `projectOf`) (kept past the session, cleared on release,
  disabled once one chat ran sessions in two projects).
- **A directory with an extension is only revealed** (`.app`, `.xcodeproj`): a click never launches a bundle.
  Dispatch runs on the `realpath`, so an extensionless symlink to a bundle is revealed too.
- **Editor guard:** files open via `execFile("/usr/bin/open", ["-a", editorApp, abs])`; if `editorApp`
  is unset, Terminal/iTerm or the configured `terminalApp`, the file is revealed instead
  (`open -a Terminal x.sh` would run it). A failed launch reveals; never the default app.
- A non-http(s) `<a href>` in the chat never navigates (main's `will-navigate` only catches
  http(s)); with Cmd it is routed as a path.
