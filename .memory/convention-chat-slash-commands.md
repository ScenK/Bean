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
