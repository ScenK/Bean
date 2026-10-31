# project-routines

> User-facing name is **sprouts**; code, paths, and this entry say routines — see [convention-sprouts-copy-routines-code.md](convention-sprouts-copy-routines-code.md).

Routines: cron-scheduled (or watch-triggered — see project-watch-triggers.md) multi-step automations. Definitions in `~/.bean/routines/<name>.json`
(panel-edited, hand-editable), runtime state + capped history in `~/.bean/routines/.state.json`.
Core: `cron.ts` (own 5-field parser — no dep), `routine-store.ts`, `routine-runner.ts` (pure,
DI'd; chat steps get act-now tools incl. `save_note`, NO propose_* — routine runs are
pre-authorized by saving the routine), `outbox.ts`. Core: `routine-scheduler.ts` (30s tick,
per-routine live-run count — a running cron sprout is skipped, a running watch still polls and may
fill free maxParallel slots, a watch polls once right after each run; due sprouts start together;
`appendRunRecord` keeps `lastRun` monotonic and attempt pruning waits for the last live sibling;
missed-marking, **no catch-up** — deliberate) and `routine-host.ts`
(`createRoutineHost` — the runner-deps/footer/digest-sink glue every host shares; the host
injects only spawn adapters, recall set, status/notify callbacks). Chatops digests go through
`~/.bean/outbox/*.json`, drained by the Teams/Discord bot servers at-least-once (claim renames
to `.json.sending`, ack deletes, a failed send backs off and retries up to
`OUTBOX_MAX_ATTEMPTS`, then Discord DMs the owner one notice; a crash mid-send re-delivers on
boot — duplicates accepted, no ack protocol) (Teams needs a conversation
seen once — refs persisted in `~/.bean/teams-conversations.json`). A chatops sink's `channel`
is **optional** — absent/empty = DM the **owner** only (`ownerId` in `discord.json` /
`teams.json`; teams matches the personal ref's `user.id`/`aadObjectId`; no `ownerId` = dropped
and logged — never fan out to every allow-listed user / personal chat, coworkers would get the
owner's digests, #253); present = a specific discord channel id or teams conversation id instead. The
`save_note` act-now tool is routine-only; the chat window keeps confirm-first `propose_note`.
`sinks.chatopsOnlyOnProblems` (#561, panel "Only post when a run needs me") skips the chatops
sinks for an `ok` run in `deliverDigest` — the one choke point for single, per-todo and watch
deliveries; note/notify/history still get every run. Ignored on notify-only watches (`steps: []`):
`fireNotify` always records `ok`, so the rule would mute them entirely.
`sinks.chatops` may hold several entries per transport (a DM plus channels, Discord `user` DMs);
the panel edits each entry by its index — never map over a whole transport (#562: that collapsed
extra channels into duplicates → double posts). `cleanChatSinks` (renderer `chat-sinks.ts`) trims,
drops blank rows and exact duplicates on every panel save.

**Headless host (#279).** `BEAN_HEADLESS_ROUTINES=1` makes the Discord server a routine host
(`discord/src/headless-routines.ts`): scheduler + `createRoutineHost` + core `makeRoutineSteps`
(the same delegate/command adapters main.ts uses). **One scheduler per `~/.bean`** —
`.state.json` writes are serialized in-process only; `chatops-servers.ts` strips the variable
from the bot the app spawns, keep that. Headless needs `TZ` (refuses to boot without it),
turns alarm/`notify`/missed-run notices into owner DMs via the outbox, and on boot SIGKILLs +
clears every `~/.bean/runs/` reservation (`clearReservations` — only safe because this process
owns the dir). `saveRoutine`/`saveRoutineStates` write `<file>.tmp` then rename; the temp name
must not end in `.json` (loadRoutines would load it).

Steps carry an optional stable `id` (`[a-z0-9-]`, unique per routine, assigned by
`withStepIds` in the editor only on an edit — untouched legacy JSON saves back byte-for-byte)
and an optional delegate-only `cli` pin. A pinned `cli`/`model` that this Mac can't run
**refuses before spawn** (`pinnedStepSelection`, shared message source `stepAvailabilityProblem`
for the panel warning) — never a silent fallback; unpinned steps keep inferring the CLI from
the model. The clis.json model check runs only on user saves (`saveRoutine(dir, r, cliModels)`),
never on load, so a model-list change can't make a routine vanish.

**Gates (#259).** A step's optional `gate: { onFail: "stop" | { goto, maxRounds? } }` and
`next: "<later id>" | "end"` turn the step list into a graph (`usesGates`); with neither field
anywhere the runner is the old linear loop, byte-for-byte. A gate's verdict is
`gateVerdict()` — PASS **only** when the last non-empty line is exactly `VERDICT: PASS`;
anything else is FAIL (never loosen this to "any VERDICT line": a quoted contract would pass).
Backward goto = loop, capped by executions of the gated step (default 3, max 5) per todo; whole
pass bounded at 50 executions. The goto target gets only the firing gate's newest FAIL output
as quoted data; the gated prior block keeps the latest attempt per step. Re-entered delegate
steps resume their own session (same CLI only). Outcome `needs-attention` (stop / exhausted /
last gate FAIL) is a third `RunRecord.status` — treat any `!== "ok"` as needing the user. In
gated routines the app holds a todo's run reservation + scratch dir until the run ends.

**Routes (#400).** `route: { paths: [{ when, goto }], otherwise? }` (≥2 paths, labels
`[a-z0-9-]`, unique, not pass/fail; targets forward-only or "end"; exclusive with gate/next) is
a multi-way choice that also turns on graph mode. `routeLabel()` is as strict as `gateVerdict`:
only an exact last line `ROUTE: <declared label>` counts, else `otherwise`, else needs-attention
"no path matched". A route never touches the last-gate-FAIL state — taking a path isn't a
failure. Chat/delegate deciders get a ROUTE contract listing the labels; a command step routes on
its raw stdout (before `(exit N)`) and a non-zero exit is still a step error. `verdict` = the
label. The ROUTE line is stripped from `StepResult.output` (digest, summary, lone-step
deliverable) but kept in `routine_step_attempts`; the prior block header says `chose "<label>"`.
Editor (#401): `stepEdgeWarnings` (fall-through into a sibling path's entry) and
`stepPathCaptions` live beside `stepEdgeProblems` in `routine-graph.ts` but are render-only —
never fold a warning into `stepEdgeProblems`: `parseBrief` drops flagged edges and save blocks.
Builder (#402): `cleanEdges` shape-filters `route`; `parseBrief` validates each edge kind alone
(gate / next / route) — a bad route is dropped whole, never the step, and a valid route wins over
a gate/next the model put beside it.

**Parallel groups (#416/#417).** `alongside: true` joins a step to the one above (group ≤4, rules in
`describeGroupErrors`; turns on graph mode). The runner starts every member at once on ONE frozen
prior block (the group's own earlier attempts left out) and one feedback string, awaits all, and
commits results/`latest`/`recordAttempt`/`RunRecord.steps` in step order (attempts are read
`ORDER BY id`). The whole group must fit the 50-execution budget or none starts. Policy "wait for
all, the join decides": a member's hard error/timeout/non-zero exit doesn't stop the pass; at the
end a gated pass is `failed` when any step's latest attempt failed, outranking needs-attention
(text kept). Host labels receipts from `DelegateStepRequest.stepIndex/round` — never from the last
`onStep` (members interleave) — and shows one `⫴ a · b (n of k left)` bubble line counted down in
its `recordAttempt` wrapper.
Editor (#418): the `⫴ alongside step N` chip toggles a step into the group above and never strips
an edge — a gate/next/route the group can't carry shows as that step's problem. Remove/reorder go
through `removeStep`/`moveStep` (`step-ids.ts`): a step keeps `alongside` only while the step above
is still from its own group, so nothing silently joins one; a duplicated member's copy joins.
Members share the step's scratch folder (per run, or per todo for watch/parallel todos) — best
read-only; nothing stops two members writing the same file. Children multiply: up to 16 at once
(`maxParallel` 4 todos × a 4-wide group). The chat builder (`cleanEdges`) drops `alongside` — groups
are editor/JSON-only.
Dashboard (#419): a step's status is its **latest attempt** — `splitSteps` needs you only when the
run isn't `ok` and no later record of the same id (same todo) passed; `runFlowOverlay` reads a group
as one block (all members, step order, else drift), lights every fork + join, failed members ✗, and
an error a later round of the same pass got past isn't ✗. `executedPath(run, steps)` brackets a
group: `[lint ✓ | test ✗ | review ✓]`. Diagram: forks/joins meet a bar above/below the members.

**Command steps (#265).** `kind: "command"` runs `command` via `/bin/sh -c` (core `runShellCommand`,
own process group, timeout SIGKILLs the group) in `project`, else the same scratch dir a delegate
step would use, with the app's resolved login-shell PATH. No model/memories/skill — the validator
rejects `skill`/`model`/`cli`/`instruction` on it. Verdict = exit code (0 PASS, else FAIL), never
the output text; ungated non-zero = failed step, gated = FAIL routed by the gate with the output
tail (capped 16k) as feedback; timeout = hard step error. Todo runs get `BEAN_TODO_ID`/`BEAN_TODO_TEXT`
env. No run reservation (a check reads the tree). Not creatable from chatops — same trust as a
watch command.

**Authoring + inspecting flows (#260).** The step editor writes gates/next without JSON: a gate
chip (Keep going / Stop / Go to → step N, + a max-rounds chip only for a backward target), an
"end run here" toggle, and rail markers (■ stop, ↩N loop, ↪N branch, →N/end next). Edge rules
live once in node-free `@bean/core/routine-graph` (`describeEdgeError`, `stepEdgeProblems`) —
the save validator and the editor's inline per-step warnings share them, so a reorder/delete
that breaks an edge is flagged before save with the save-time wording. Picking a goto runs
`withStepIds` first (edges need ids). The builder brief may emit `gate`/`next`/`command`/`cli`;
`parseBrief` drops a bad edge, never the step. The avatar bubble shows `round N/cap` for a
looping gate. Dashboard side: see [project-dashboard-panel](project-dashboard-panel.md).


**Example flows (#261).** No fixed template: `@bean/core/routine-examples` (node-free) holds a
few disabled starting points (dev loop, ticket lint first, review only) built from generic
repo-shipped skills (`ticket-lint`, `implement`, `review`, `pr`, `ask-on-ticket` in
`.bean/skills/`). "Start from an example" chips (Routines empty state + the New pane) only open
the editor pre-filled — nothing saves until Save, and `exampleRoutine` renames on a name clash
so a save can't overwrite. Existing routines are never rewritten. To turn a single-step
routine (e.g. one autonomous-dev delegate) into a gated flow: split it into
implement / test (command) / review steps, gate test and review with "Go to → implement", and
end with a pr step — or open the Dev loop example and copy its watch command over. The
ReviewPane shows `stepProblemsText` before Enable, so a pinned harness that's missing warns.

**Chat authoring (#285, owner only).** `propose_routine` (one JSON-string arg) is offered
only when bot deps wire `routines` and the speaker can `routineWrites` (owner). `chatRoutineProblem`
= `describeRoutineError` + no command steps/watches + chatops sinks only on the surface's own
`routines.transport` (#320; a channel sink only the drafting channel) + `user` sinks only to the owner/household
members (`routines.recipients()`, never a model-written id); an invalid draft still gets a card
showing the reason with only Cancel, and Save re-validates. Card taps (`*-routine`) are owner-only
and conversation-bound; the enabled toggle mutates the pending draft. Owner text commands
`routines` / `enable <name>` / `disable <name>` are core keyword commands (exempt from the turn cap,
no thread) — `parseRoutineCommand` is shared with Discord's server.ts. Teams wires it too (#321): owner-only
recipients (no `user` sinks), channel sink = `scopeOf`'s bare channel id / group chat id. "Every N
days" is steered to weekday lists: a `*/N` day-of-month restarts on the 1st, and the card's
`warnings` say so.
