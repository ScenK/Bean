# `run_audit`: the chatops run audit log

`bean.db`'s `run_audit` (`run-audit.ts`, #1145) holds one row per Discord/Teams delegate run attempt
and per chatops live session: who asked / confirmed / cancelled (platform id + display-name
snapshot), trigger (`card` | `continuation` | `follow_up` | `live`), project, skill, CLI, model, the
instruction that ran (+ `instruction_proposed` only when edited on the card), session id, outcome.
It is separate from `delegate_runs` (the resume index) — don't merge them.

- **Writers:** `RunRegistry` (start → `running` before spawn; strict-resume refusals; settle; cancel
  records the canceller at the request; `interruptAll` → `interrupted`), `bot.ts` (`auditOf()` builds
  the identity; missing-skill / no-CLI / recheck refusals via `runs.recordRefused`), and
  `LiveSessionRegistry` (only with its `surface` set). Desktop, routine and away-prepare runs are
  deliberately not audited.
- **Never written:** composed prompts, skill bodies, memories, CLI output or error text — `outcome`
  is an enum (tests canary this). `main.log` stays the only raw-error log.
- **Continuations / follow-ups** carry the grant confirmer as `authority_id`; never fabricate a
  `confirmed_by_*` for them. A follow-up has no asker (Bean asked).
- Every write is fail-open (try/catch, data-free warning): an audit failure never alters a run.
