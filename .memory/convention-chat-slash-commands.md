# Desktop chat `/` commands (#494)

`renderer/components/chat/slash-commands.ts` is the one registry (pure, DOM-free). Rules that
are easy to break:

- **Parse only in `ChatWindow.onComposerSend`.** Loopbacks, pushed chat prompts, skill prompts
  and Save to notes call `sendMessage` directly — a `/skill` in their text must never run.
- **Match by slug** (`slugify`): skill names are file basenames with spaces. Bare `/name`
  resolves agents > skills; `/skill:` picks a skill. **No sprouts** (#635) — ask Bean to run one
  (`propose_sprout_run` card); `/sprout:x` is plain text. Two entries of one
  kind sharing a slug are an error row, never a silent pick — a menu pick runs the row's
  `command` text, so it hits the same check.
- Unknown bare `/foo` is plain text to Bean; unknown `/skill:` / ambiguous are error rows and no
  model work runs.
- **Agent mode (#597)** resolves agents and skills (unknown `/foo` goes to the CLI as text, so a Bean skill shadows a same-slug CLI command). Any skill, chat or
  terminal target, is composed in the renderer and sent into the live session (`sendToAgent` with
  a `▶` `display` label, which the host's `live-tasks.ts` records as the run's instruction) — no card. Images and a
  `browser: true` skill on opencode are refused inline.
- A chat skill run keeps `source: "skill"` (no memory tools, host `chat.ts`).
- A terminal skill (#495, #585) opens a **pending** delegate card on Enter; its Start takes focus
  (`autoFocus`, only the card a `/` send created — Bean-proposed/restored cards never do) so a
  second Enter runs it, and a key-repeat Enter is ignored so a held key can't. The card's project
  picker (assigned first, plus scratch `""`) and model (seeded once from model memory) can be
  changed first; `confirmDelegate` saves the picked model per skill.
  Its menu caption `<CLI> · <project>` comes from `terminalDestination()`, which must mirror
  the host's `resolveDelegateSelection` (a test pins the parity). No project → `""`, which
  `delegate-tasks.ts` maps to the real scratch path. Browser access stays the host's re-derivation
  from `skillName`; never send a flag from the renderer.
- **The menu keys on the `/word` before the caret** (`slashToken`), not the whole composer, so a
  `/` typed in front of a draft opens it; a pick keeps the draft as the instruction (`slashPick`).
  `slashText` is state and the caret moves without input events — every pick path must re-check
  it against the live caret (`live` in the keydown handler), or a stale menu runs a skill.
