# project-watch-triggers

Routines fire on `cron` XOR `watch` (#173). A watch is a deterministic poll — **no model per
check**: `{kind:"feed", url}` (hand Atom/RSS parser in `core/watch.ts`, no XML dep) or
`{kind:"command", command}` (`/bin/sh -c`, resolved login-shell PATH, 60 s / 1 MB, stdout =
JSON lines or one array of `{id,text}`; `app/watch-io.ts`). `steps: []` = notify-only (digest
built in the scheduler, one `RunRecord{steps:[]}` per fire); steps present ⇒ must be
`todoDriven` and each new item is queued as a todo — **the queue is the due signal**, the poller
never calls `runRoutine`.

Decisions worth keeping:
- **Seen-set is SQLite** (`watch_seen` + `watch_source` in `bean.db`, `core/watch-store.ts`).
  `watch_source` makes "seeded" explicit: a source empty at seed time still counts as seeded
  (otherwise the first real item would be swallowed as a re-seed), and a changed url/command —
  panel or hand edit — wipes the set so it re-seeds. Still-present ids get `seen_at` refreshed so
  the `max(500, 2×poll)` cap only evicts ids that left the source.
- **"Needs review" is derived, not stored**: `!enabled && watch && !seeded`. The review card's
  Enable re-checks the source and seeds from *that* check (`scheduler.enableWatch`); the list
  pill on such a row opens the review instead of a bare flip.
- **All `.state.json` writes go through the scheduler's one promise chain** (`withStates`):
  ticks overlap once a long run keeps one tick awaiting. Due routines execute *after* the tick's
  poll pass so one long run can't stall other watches. `lastPoll`/`pollError` persist;
  the consecutive-failure count is in memory (alarm = one desktop notification at 3; the panel
  status line is the guarantee, the Dashboard shows the error only after 3).
- Watch-fired todo runs: project-less delegate steps get `scratchDir/<todo id>` (removed after);
  project steps must win `reserveRun`, else `RunBusyError` ⇒ todo back to pending, run
  `deferred` (nothing recorded).
- **Builder** (desktop only): brief = plain `/v1/responses` call with no tools (not a
  `propose_*` — converse's tool list stays byte-stable); command watches are built by a headless
  delegate with the hidden `build-routine` skill, which never writes `~/.bean` — Bean parses the
  last ```json fence, keeps the brief's name/interval/sinks, re-runs the command itself, saves
  drafted skills only under free names, and saves the routine **disabled**. Feed briefs skip the
  agent (`discoverFeedUrl`). Schedule briefs just open the manual editor. Builds live in main
  (`app/routine-builder.ts`) so closing the window doesn't lose them.
- Known limits: command timeout SIGTERMs only the shell; a crash between seen-set write and
  `addTodo` drops those items; `acli` PATH detection wasn't verified on a machine that has it.
