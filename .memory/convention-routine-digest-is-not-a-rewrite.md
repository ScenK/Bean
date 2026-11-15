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
brief (`routine-chat-brief.ts`, one model call per run from `deliverDigest`): the model reads
**every** step's output (`chatBriefInput`: latest attempt per step/todo, minus the todo label,
`VERDICT:`/`ROUTE:` lines, a command's `(exit 0)`, an outer fence) and writes a **short,
conclusion-first** message — the outcome, then only what the user must know or act on. The
voice is the persona's; the prompt fixes no opening and does not force first person. The prompt
does fix the layout (conclusion on its own line, a blank line, then short bullets): without it
the model posts one dense paragraph, which reads as a wall in Discord.

It is a summary, so the code-side guard checks the other way round from a restyle: at most
`BRIEF_MAX_CHARS` per task and no link or number the run didn't report (this has caught a
mistyped repo URL). Links of the final step the model left out are appended by code, not
rejected — models drop the PR link about one time in five. A guard miss, a cut-off reply,
input over 60,000 chars, a timeout or an error
posts the **final step's output** as it is (`finalStepOutput`: the last step executed per todo,
every member of a closing parallel group) — not the digest. Failed/needs-attention and stepless
runs post the digest. `sinks.chatopsVerbatim: true` (the Sprouts panel's "Sum up as a short
brief" box, unchecked) posts the full digest word for word — the switch for sprouts where
fidelity beats brevity; `config.json` `briefModel` (no Settings UI, boot-time) picks the model.
Code text appended to the digest (the retro footer) rides on `RoutineRunResult.footer` so the
brief re-appends it — a new code-owned digest line needs the same treatment.

Don't go back to "restyle every step at the same length". The first cut did (a ≥0.7× length
floor, "do not summarize", "I checked… I found…"): chat posts tripled (about 1k → 2.5–4k chars),
repeated each step's facts, leaked `WORKTREE:`/`COUNTS:` lines and opened every sentence with
"I found". Don't cut the input to the last step either — the model needs the whole run to
pick what matters. Sprouts whose steps are independent reports, or whose output is a formatted
team report, should set `chatopsVerbatim`: a trial brief of a three-branch rebase said "all five
branches" — a number in words passes the guard.
