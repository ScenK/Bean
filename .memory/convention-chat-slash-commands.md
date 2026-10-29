# Desktop chat `/` commands (#494)

`renderer/components/chat/slash-commands.ts` is the one registry (pure, DOM-free). Rules that
are easy to break:

- **Parse only in `ChatWindow.onComposerSend`.** Loopbacks, pushed chat prompts, skill prompts
  and Save to notes call `sendMessage` directly — a `/sprout:x` in their text must never run.
- **Match by slug** (`slugify`): skill names are file basenames with spaces. Bare `/name`
  resolves agents > skills > sprouts; `/skill:` / `/sprout:` pick a kind. Two entries of one
  kind sharing a slug are an error row, never a silent pick — a menu pick runs the row's
  `command` text, so it hits the same check.
- Unknown bare `/foo` is plain text to Bean; unknown qualified / ambiguous / sprout-with-text are
  error rows and no model work runs. Agent mode resolves agent aliases only.
- A chat skill run keeps `source: "skill"` (no memory tools, `ipc.ts`). A sprout run gets one
  status row per invocation (`updateStatus` by id) so parallel runs don't cross.
- A terminal skill (#495) runs as a tracked delegate straight from Enter (no confirm card step).
  Its menu caption `<CLI> · <project>` comes from `terminalDestination()`, which must mirror
  main's `resolveDelegateSelection` (a test pins the parity). No project → `""`, which
  `delegate-tasks.ts` maps to the real scratch path. Browser access stays main's re-derivation
  from `skillName`; never send a flag from the renderer.
