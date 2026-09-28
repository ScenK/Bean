---
description: Internal — Bean's routine builder uses this to write and test a watch command. Never pick it for chat.
hidden: true
---

# Build a Bean watch routine

You are building ONE Bean routine from the brief below. Bean polls the routine's **watch command**
every few minutes with no model involved, so the command must be deterministic and must work
unattended with the user's existing CLI logins.

## Hard rules

- **Never write, edit, or delete anything under `~/.bean`.** Bean is the only writer — you only
  return JSON. Don't create files outside the current working directory.
- **Never** post, comment, approve, merge, assign, or change anything in any external system.
  The watch command is read-only.
- Don't ask questions — there is no user present. If the brief is ambiguous, pick the safest
  read-only interpretation.

## The watch command contract

- Runs as `/bin/sh -c "<command>"` with the user's login-shell `PATH`, 60 s timeout, 1 MB output cap.
- Prints the **current** matching items (not just new ones — Bean diffs against what it has seen)
  as JSON lines **or** one JSON array, each item `{"id": "<stable unique id>", "text": "<one line a human reads>"}`.
  - `id` must stay the same for the same item across runs (a URL or key, never a timestamp).
  - `text` should start with the item's URL or key, then its title, e.g. `"https://github.com/o/r/pull/12 Fix the flaky test"`.
- Exit 0 with empty output = nothing there right now. Any non-zero exit = a failed check.
- Prefer the CLI named in the brief (`via`) and its built-in JSON output (`--json` + `--jq`, `jq`).

## Steps

1. Write the command. Then print exactly this line on its own: `BEAN-STEP: command`
2. **Test it for real** by running it once. Check the exit code and that the output parses as the
   contract above. Print on its own line: `BEAN-STEP: tested exit=<code> items=<count>`
   - If it fails (auth missing, bad flags, wrong shape) and you can fix it within the rules, fix
     and re-test. If you can't, stop and return the `testError` form below with the command's
     stderr and exit code.
3. Draft the routine's steps from the brief. Each step's instruction is run once per new item,
   with the item's `text` appended as "Queued task". Keep the brief's skills, projects, and
   models unless they can't work. If a step needs a skill that doesn't exist, draft it (a Bean
   skill is markdown with optional `description:` frontmatter; omit `target:` for coding-agent
   skills) and return it under `skills` — Bean saves it only if the name is free.
   Print on its own line: `BEAN-STEP: steps`
4. Finish with your final message ending in ONE fenced json block — the last ```json block is
   what Bean reads:

```json
{
  "routine": {
    "watch": { "kind": "command", "command": "<the tested command>" },
    "steps": [{ "kind": "delegate", "skill": "code-review", "instruction": "Review the PR in the queued task…" }]
  },
  "skills": [{ "name": "kebab-name", "markdown": "---\ndescription: …\n---\n\n# …" }]
}
```

   or, when the test failed:

```json
{ "routine": { "watch": { "kind": "command", "command": "<what you tried>" } },
  "testError": { "message": "<stderr, trimmed>", "exitCode": 4 } }
```

Bean keeps the brief's name, interval, and destinations, re-runs your command itself, and saves
the routine **disabled** so the user reviews it before anything runs.
