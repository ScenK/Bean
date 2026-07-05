# safety: skill frontmatter never goes into prompts; opencode gets `--prompt=` as one token

A user skill starting with a frontmatter block used to launch opencode with **no prompt at
all**: `composePrompt()` embedded the raw body (frontmatter included), so the prompt began
with `---`, and opencode's yargs parser ate the value after `--prompt` as another flag —
TUI opened, prompt silently empty.

Three guards now exist; don't undo any of them:

- `composePrompt()` strips frontmatter via `stripFrontmatter()` — frontmatter
  (`description`/`target`/`enabled`) is Bean metadata, never prompt content.
- `launchCommand()` passes `--prompt=<text>` as a single token so a prompt that still
  starts with `-` can't be parsed as a flag.
- The Skills editor blocks Save until the frontmatter has a valid `target: terminal|chat`.
  **Never auto-insert `target:`** — where a skill runs is the user's decision (Bean can't
  assume a terminal run is appropriate); `formatSkillBody()` in `saveSkill()` is
  whitespace-cleanup only. Validation is save-time only, not a live banner (user feedback:
  an always-on warning over an empty editor is noise). Skills added straight to
  `~/.bean/skills/` on disk bypass this check; a missing target still behaves as terminal
  in `loadSkills()`.
