# Delegate session receipts (#203)

Every delegate run whose CLI session actually started appends one row to `bean.db`'s
`delegate_runs` (`core/src/delegate-runs.ts`, `recordDelegateSession`), from
`runDelegate`'s `onSessionStart(pid, sessionId)` — so failed, cancelled and timed-out runs are
recorded too; runs that die before the session starts have no id and no row. Append-only:
a thread follow-up resumes the same id, so repeated `session_id`s mean one continuous session.
No retention job. A failed write is logged without values and never alters the run.

Receipts (terminal states only — copying mid-run would put two writers on one transcript):
- **Desktop** delegate card: `claude · 3f2a…` chip + Copy → `cd '<path>' && claude --resume <id>`.
  Computed in main (`delegate-tasks.ts`), carried on the `done`/`failed`/`cancelled` event;
  never in loopback text or the memory transcript.
- **Discord/Teams** finished card: `Resume (<project name>)` + the command. **Never a path**
  (shared channel) — an unregistered project falls back to the folder basename.
- **Routines**: `withResumeFooter` appends `step N (<project>|workspace) — <cmd>` lines to both
  `result.digest` and `result.record.digest`; the collector is per `runOneRoutine` call so
  concurrent routines can't mix ids. Bean writes it, never the model.

Session ids are untrusted subprocess output: only `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`
(`isValidSessionId`) is accepted — the leading alphanumeric blocks `--help`-style values.

Not recorded: the routine builder's `startAgent` (internal tooling) and live sessions.
Recovery after a restart (no UI by design):

```sh
sqlite3 -readonly -header -column ~/.bean/bean.db \
  "SELECT started_at, surface, cli, session_id, project_path, substr(instruction,1,60) AS instruction
   FROM delegate_runs ORDER BY id DESC LIMIT 20"
```

OpenCode cross-directory resume (`opencode -s <id>` from another cwd) is unverified — run it
from the project folder.
