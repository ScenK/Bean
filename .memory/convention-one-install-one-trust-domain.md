# One Bean install = one trust domain

A Bean install is a single trust domain. A chatops install (e.g. the Teams bot) is a shared
team instance whose memory is team-shared **by design**; personal data lives in a separate
desktop install. Since #254 not every speaker gets every power: guests only chat, admins (per
channel) get memory/notes/delegation, the owner everything — see
[safety-chatops-roles](safety-chatops-roles.md). Memory itself stays global: an admin in one
channel can recall and forget what was saved in another, and anything Bean posts in a channel
is visible to all its members. That is accepted, not a leak to re-flag.

Routine steps inherit relevance-selected memories at run time (#211, `stepMemories()` in
`routine-runner.ts`). The rendered block is **runtime-only**: it rides its own field
(`DelegateStepRequest.memories`, its own chat system part) and must never be concatenated
into `instruction`, `StepResult`/`RunRecord`, `.state.json`, `delegate_runs`,
`routine_step_attempts` (step-attempts.ts — stores only the step's own output), cards, or logs.
