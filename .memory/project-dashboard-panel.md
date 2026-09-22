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
- **`.bean-md` sets no font-size**, so markdown dropped into a panel inherits the window's 16px
  and its 13.5px headings come out *smaller than the prose under them*. Any new markdown surface
  needs its own body font-size (`.bean-dash-digest-body`) — this is why the digest looked wrong.
- **Per-step timestamps don't exist**, only run start/finish, so the spine's time column reads
  `step N` for step rows. Adding real step times means changing `RunRecord` in core.
- **Reviewing is per run, scoped to the day on screen** (`localStorage`, per
  [convention-renderer-view-prefs-in-localstorage.md](convention-renderer-view-prefs-in-localstorage.md)
  — nothing in main or another surface reads it). It was a single "seen up to here" timestamp
  first; that silently cleared every older day too, which is why `reviewRuns()` stores ids and
  prunes them against the live run list instead. The latest run's digest starts open, older
  ones shut — stored as the list of runs *flipped away from* that default.
- **A todo-driven run records one pass of every step per todo**, so a step's position in
  `RunRecord.steps` is not the routine's step number. The runner prefixes those outputs with
  `[todo: <text>] `; `parseStep()`/`stepLabel()` read that prefix and name the todo instead of
  claiming a wrong "Step N". Don't reintroduce position-as-step-number.
- **Deferred (review policy P2):** "Run routine again" on a todo-driven routine with an empty
  queue records a successful no-op run. Guarding it needs a `todosList` poll the dashboard
  otherwise doesn't want; the row it leaves is visible and harmless.
- **The unit of selection is a whole local day**, not a run and not a routine: the rail is one
  row per day, and the spine renders every routine that ran that day as a section (`RunBucket`
  out of `groupRuns()`) of RUN 1, RUN 2, … each run with its own resolved line, cards and
  digest. NEEDS YOU cards are numbered across the whole day, so the morning has one end rather
  than one per run or per routine, and **each routine's latest run opens its digest** — not just
  the day's last one. **Newest-first at every level**, buckets included, with the "you are here"
  marker at the TOP of the spine: the latest thing Bean did is the first thing you read. A run's
  displayed ordinal is therefore `runs.length - index`, so RUN 2 sits above RUN 1.
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
