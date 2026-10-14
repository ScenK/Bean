# project-routines

Routines: cron-scheduled (or watch-triggered — see project-watch-triggers.md) multi-step automations. Definitions in `~/.bean/routines/<name>.json`
(panel-edited, hand-editable), runtime state + capped history in `~/.bean/routines/.state.json`.
Core: `cron.ts` (own 5-field parser — no dep), `routine-store.ts`, `routine-runner.ts` (pure,
DI'd; chat steps get act-now tools incl. `save_note`, NO propose_* — routine runs are
pre-authorized by saving the routine), `outbox.ts`. Core: `routine-scheduler.ts` (30s tick,
skip-if-running, missed-marking, **no catch-up** — deliberate) and `routine-host.ts`
(`createRoutineHost` — the runner-deps/footer/digest-sink glue every host shares; the host
injects only spawn adapters, recall set, status/notify callbacks). Chatops digests go through
`~/.bean/outbox/*.json`, polled by the Teams/Discord bot servers (Teams needs a conversation
seen once — refs persisted in `~/.bean/teams-conversations.json`). A chatops sink's `channel`
is **optional** — absent/empty = DM the **owner** only (`ownerId` in `discord.json` /
`teams.json`; teams matches the personal ref's `user.id`/`aadObjectId`; no `ownerId` = dropped
and logged — never fan out to every allow-listed user / personal chat, coworkers would get the
owner's digests, #253); present = a specific discord channel id or teams conversation id instead. The
`save_note` act-now tool is routine-only; the chat window keeps confirm-first `propose_note`.
Spec: `docs/superpowers/specs/2026-07-12-routines-design.md`.

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
