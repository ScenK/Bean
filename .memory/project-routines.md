# project-routines

Routines: cron-scheduled (or watch-triggered — see project-watch-triggers.md) multi-step automations. Definitions in `~/.bean/routines/<name>.json`
(panel-edited, hand-editable), runtime state + capped history in `~/.bean/routines/.state.json`.
Core: `cron.ts` (own 5-field parser — no dep), `routine-store.ts`, `routine-runner.ts` (pure,
DI'd; chat steps get act-now tools incl. `save_note`, NO propose_* — routine runs are
pre-authorized by saving the routine), `outbox.ts`. App: `routine-scheduler.ts` (30s tick,
skip-if-running, missed-marking, **no catch-up** — deliberate). Chatops digests go through
`~/.bean/outbox/*.json`, polled by the Teams/Discord bot servers (Teams needs a conversation
seen once — refs persisted in `~/.bean/teams-conversations.json`). A chatops sink's `channel`
is **optional** — absent/empty = DM the **owner** only (`ownerId` in `discord.json` /
`teams.json`; teams matches the personal ref's `user.id`/`aadObjectId`; no `ownerId` = dropped
and logged — never fan out to every allow-listed user / personal chat, coworkers would get the
owner's digests, #253); present = a specific discord channel id or teams conversation id instead. The
`save_note` act-now tool is routine-only; the chat window keeps confirm-first `propose_note`.
Spec: `docs/superpowers/specs/2026-07-12-routines-design.md`.

Steps carry an optional stable `id` (`[a-z0-9-]`, unique per routine, assigned by
`withStepIds` in the editor only on an edit — untouched legacy JSON saves back byte-for-byte)
and an optional delegate-only `cli` pin. A pinned `cli`/`model` that this Mac can't run
**refuses before spawn** (`pinnedStepSelection`, shared message source `stepAvailabilityProblem`
for the panel warning) — never a silent fallback; unpinned steps keep inferring the CLI from
the model. The clis.json model check runs only on user saves (`saveRoutine(dir, r, cliModels)`),
never on load, so a model-list change can't make a routine vanish.
