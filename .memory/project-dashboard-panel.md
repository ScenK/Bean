# Dashboard panel — digesting routine output

The Dashboard (`renderer/components/dashboard/`) is the read side of routines: the rail lists
every routine's runs as one newest-first stream, the main column renders the selected run as a
time spine (design 4a, "night-shift ledger").

**It adds no backend.** Everything comes from the existing `routinesList()` + `routinesState()`
IPC — `RunRecord` already carries `startedAt`/`finishedAt`/`status`/`digest`/`steps[]`. Don't
add a dashboard-specific channel or store without a reason the existing two can't cover.

Mapping decisions worth keeping:

- **A failed step is the only thing that can "need you."** `splitSteps()` in `runs.ts` turns
  failed steps into the numbered NEEDS YOU cards and collapses passing steps into the single
  RESOLVED line. There is no per-entry approval/dismissal state anywhere in Bean, so the design's
  "Dismiss" affordance was deliberately not built — it would have to lie or invent a store.
- **Per-step timestamps don't exist**, only run start/finish, so the spine's time column reads
  `step N` for step rows. Adding real step times means changing `RunRecord` in core.
- **Reviewing is per run, scoped to the day on screen** (`localStorage`, per
  [convention-renderer-view-prefs-in-localstorage.md](convention-renderer-view-prefs-in-localstorage.md)
  — nothing in main or another surface reads it). It was a single "seen up to here" timestamp
  first; that silently cleared every older day too, which is why `reviewRuns()` stores ids and
  prunes them against the live run list instead. The latest run's digest starts open, older
  ones shut — same flipped-from-default list trick as the day folds.
- **A todo-driven run records one pass of every step per todo**, so a step's position in
  `RunRecord.steps` is not the routine's step number. The runner prefixes those outputs with
  `[todo: <text>] `; `parseStep()`/`stepLabel()` read that prefix and name the todo instead of
  claiming a wrong "Step N". Don't reintroduce position-as-step-number.
- **Deferred (review policy P2):** "Run routine again" on a todo-driven routine with an empty
  queue records a successful no-op run. Guarding it needs a `todosList` poll the dashboard
  otherwise doesn't want; the row it leaves is visible and harmless.
- **The unit of selection is a routine's whole local day**, not one run (`RunBucket` out of
  `groupRuns()`): the rail is local day → routine (one row even when it fired five times), and
  the spine renders that bucket's runs in order as RUN 1, RUN 2, … each with its own resolved
  line, cards and digest. NEEDS YOU cards are numbered across the bucket, so the morning has one
  end rather than one per run. Bucket runs are stored oldest-first (a day reads forward) while
  days and routines stay newest-first. Fold state is a single localStorage list of day headers
  *flipped away from their default* — newest day open, older days shut — not separate
  collapsed/expanded sets.
- `runs.ts` is pure and unit-tested (`__test__/dashboard-runs.test.ts`); the panel holds the JSX.

**Adding any new component window touches five places** — miss one and it fails at a different
stage each time: `channels.ts` (`ComponentKind`), `windows.ts` (size + title maps, both
exhaustive `Record<ComponentKind, …>`), `esbuild.config.mjs` (entry point **and** the
`copyStaticAssets` html list), `renderer/avatar.ts` (icon + `QUICK_ACTIONS` tile), and
`avatar-menu.ts` (`AVATAR_MENU_SIZE.height`, 60px per tile — but leave `AVATAR_DRAG_SIZE`
alone, `avatar-menu.test.ts` asserts the drag bloom fits unclamped in a 900px work area).
Add the new kind to `e2e/contrast.e2e.ts`'s `WINDOWS` list too, and give it fixture data in
`e2e/fixtures/bean-home.ts` if its empty state wouldn't exercise the real UI — the dashboard's
NEEDS YOU badge only failed AA once the fixture had a run to render.
