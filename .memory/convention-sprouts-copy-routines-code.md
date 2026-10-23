# convention-sprouts-copy-routines-code

Users see **sprouts**; code says **routines**. Every user- and model-facing string (window title,
panel/builder copy, cards, chatops replies, refusals, digests, notifications, validation errors,
tool *descriptions*, `.bean/skills/bean.md`) says "sprout". Everything machine-facing stays
"routine": identifiers, file names, `~/.bean/routines/` paths, JSON keys, IPC channels
(`bean:routines-*`), CSS classes (`bean-routines-*`), `kind: "routines"`/`openComponent("routines")`,
tool names (`propose_routine`) and arguments (`routine`), card action ids (`save-routine`…),
note slugs (`routine-<name>`), `BEAN_HEADLESS_ROUTINES`, and `console.*`/boot log lines.

- The model echoes tool descriptions, so `propose_routine`/`propose_todo` carry a bridge
  sentence ("The user calls these sprouts; this tool's name … internal — always say sprout").
  Keep it when editing those descriptions.
- `parseRoutineCommand` and Discord's `KEYWORD_COMMAND` accept both `sprouts` and the old
  `routines`; the catalog/Teams manifest/Discord picker advertise only `sprouts`.
- New copy: write "sprout". Check with
  `git grep -nP '"[^"]*\b[Rr]outines?\b' packages/*/src` — leftovers must be machine-facing.
