# project-routines

Routines: cron-scheduled multi-step automations. Definitions in `~/.bean/routines/<name>.json`
(panel-edited, hand-editable), runtime state + capped history in `~/.bean/routines/.state.json`.
Core: `cron.ts` (own 5-field parser — no dep), `routine-store.ts`, `routine-runner.ts` (pure,
DI'd; chat steps get act-now tools incl. `save_note`, NO propose_* — routine runs are
pre-authorized by saving the routine), `outbox.ts`. App: `routine-scheduler.ts` (30s tick,
skip-if-running, missed-marking, **no catch-up** — deliberate). Chatops digests go through
`~/.bean/outbox/*.json`, polled by the Teams/Discord bot servers (Teams needs a conversation
seen once — refs persisted in `~/.bean/teams-conversations.json`). A chatops sink's `channel`
is **optional** — absent/empty = DM the user directly (the default: discord DMs every
`allowedUserIds` entry, teams proactively messages every known `conversationType === "personal"`
conversation); present = a specific discord channel id or teams conversation id instead. The
`save_note` act-now tool is routine-only; the chat window keeps confirm-first `propose_note`.
Spec: `docs/superpowers/specs/2026-07-12-routines-design.md`.
