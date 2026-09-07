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
