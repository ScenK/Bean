# safety: agy (Antigravity CLI) delegate quirks

Verified on agy 1.5.14 (#1078). Re-probe after an agy upgrade.

- **Prompt as one token.** agy uses Go's flag parser: delegates pass `-p=<prompt>`, Terminal
  launches `--prompt-interactive=<prompt>`. A separate argv value starting with `-` (a bullet,
  `---` frontmatter) must never follow the flag.
- **Unknown `--conversation` id = silent fresh start.** agy prints a stderr warning, starts a new
  conversation and exits 0, so the generic "rejected resume" retry never fires. `runDelegate`
  compares `init.conversation_id` with the resume id and prepends the "started fresh" notice;
  the new id is the one recorded. Non-UUID ids are dropped before spawn.
- **Signed out never shows stderr.** Signed out, agy waits 60s for an OAuth login with the login
  URL on stderr, then exits 1 with a `status: "ERROR"` result. Any agy failure reports
  `AGY_SIGNED_OUT` or the result's `error` — never the stderr tail — and a signed-out run is not
  retried fresh. Auth lives in the OS keychain, so `bean-core`'s boot line says `agy=unknown`.
- **Stream shape.** `{event:"init"|"step_update"|"result"}`; tool steps tail as `▸ <tool_name>`
  (never the command line); prose is buffered per `step_index` and emitted once on `DONE`.
- **Live sessions (#1079)** run on the per-turn engine (`agy-live-session.ts`) with the same argv
  and parsing. agy never rejects a resume, so `rejected` never matches: a continued id agy no longer
  has surfaces as a different `init` id, which the engine's mismatch path stops before any output.
  agy reaps its tool process groups on neither SIGINT nor SIGTERM: stop SIGTERMs the whole tree.
