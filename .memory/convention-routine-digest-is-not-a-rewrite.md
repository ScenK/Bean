# Routine digest must not rewrite a step's report

A routine's *step output* is often the deliverable itself (e.g. the Sigma Standup skill, whose
prompt forbids preambles and "Step 1 —" narration). `runRoutine` used to always re-summarize
every run through `composeDigest()` on `deps.model` (config model, not the step's model), and
fed it `priorOutputsBlock()` — which tail-truncates each step to 4000 chars. Result: the Teams
sink got a short rewrite of the report's last 4000 chars, silently dropping the first half of
the members and bolting on "Overall status / Step 1 / FAILED steps".

Rules now encoded in `routine-runner.ts`:

- One step, ok → digest **is** that step's output, verbatim. No chat call.
- Multi-step → digest still composed, but on `DIGEST_OUTPUT_CAP` (100k), not the 4k
  step-chaining cap. `PRIOR_OUTPUT_CAP` stays 4k — it exists to keep *later steps'* prompts
  small, not to size the deliverable.

If you add a new digest path, don't reintroduce a summarizing pass over content a skill already
formatted for the reader.

## The chat copy is the one exception (#871)

The **record** is never rewritten: `record.digest`, the note sink and the desktop notification
always get `result.digest` byte for byte. Only the **chat sinks** of an `ok` run with steps get a
first-person brief (`routine-chat-brief.ts`, called once per run from `deliverDigest`), built
from the raw step outputs (latest attempt per step/todo, `VERDICT:` lines and the
`StepResult.todo` label stripped), not from the composed digest. It is a restyle, not a
summary: a code-side guard (every URL, fenced block and digit-bearing token kept, ≥0.7× the
input length, a complete reply) falls back to the verbatim digest, as do failed/needs-attention
runs, stepless runs, input over 12,000 chars, timeouts and errors. `sinks.chatopsVerbatim: true` (the Sprouts panel's "Rewrite as a first-person brief" box, unchecked)
opts a sprout out; `config.json` `briefModel` (no Settings UI, boot-time) picks the model. Code
text appended to the digest (the retro footer) rides on `RoutineRunResult.footer` so the brief
re-appends it — a new code-owned digest line needs the same treatment.
