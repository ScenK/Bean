# Retro routine: drafted skill proposals (#262)

A chat step whose skill is `retro` (`RETRO_SKILL`, `core/src/retro.ts`) is special-cased in
`runSteps`, not by its skill prose: its tool list is exactly `[run_history]` on every round, it
gets no recalled memories and no web search. Keep that enforcement in core — a skill edit or an
injected run output must not be able to widen it.

- `run_history(routine, n)` is the only way the step sees runs; it records which routines' skills
  and which run ids it showed. A proposal is persisted only if its target is a skill one of those
  routines uses whose current body run_history showed in full (never `retro` itself), every evidence id was shown, and it has exactly
  `skill/body/rationale/evidence`. Bean parses the trailing ```` ```proposals ```` block; the model
  never writes to the DB.
- `finish()` runs only after the step resolved within its timeout — a failed or timed-out retro
  publishes nothing. Proposals live in `bean.db`'s `skill_proposals` (survive restart) and pin
  their evidence runs' `routine_step_attempts`; unpinning/applying is the Skills-panel inbox (#263).
- `baseHash` = sha256 of the effective skill body (same hash as `StepAttempt.skillHash`) — the
  apply-time stale check.
- The digest footer ("N skill proposal(s) waiting in Bean → Skills") is appended by the app via
  `withProposalFooter`, like `withResumeFooter` — never model text.
- **Inbox (#263)** — Skills panel → Proposals; tray row when any wait. `approveSkillProposal`
  re-hashes the *effective* layered body against `baseHash` (stale → refuse; UI offers Regenerate =
  reject + run the retro routine now), writes the **user layer only** (built-in target → override;
  `.bean/skills` is read-only when packaged), and stores `prev_body` (NULL = no prior user file) +
  `applied_hash`. `undoSkillProposal` restores those exact bytes (or deletes the override) only
  while the user file still hashes to `applied_hash`. Both run inside `serializeSkillWrite`, the
  same in-process queue `saveSkill`/`deleteSkill` use — don't bypass it with a raw write. The bot
  processes' `propose_skill` writes aren't in that queue (ponytail note in `skill-library.ts`).
