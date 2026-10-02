# One Bean install = one trust domain

A Bean install is a single trust domain. A chatops install (e.g. the Teams bot) is a shared
team instance whose memory is team-shared **by design**; personal data lives in a separate
desktop install. Digests and memories reaching that install's own audience is intended — don't
re-flag open Teams access or shared memory as a leak (#209, #210 closed as not planned).

Routine steps inherit relevance-selected memories at run time (#211, `stepMemories()` in
`routine-runner.ts`). The rendered block is **runtime-only**: it rides its own field
(`DelegateStepRequest.memories`, its own chat system part) and must never be concatenated
into `instruction`, `StepResult`/`RunRecord`, `.state.json`, `delegate_runs`, cards, or logs.
