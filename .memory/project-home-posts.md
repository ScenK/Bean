# Home posts (`home_posts`, `sinks.home`)

Epic #958 (Home chat). Story #959 is the core half; the drain, the Home thread and the UI come in
later stories.

- `sinks.home: { ttlMinutes? }` on a sprout → `deliverDigest` inserts **one** `home_posts` row per
  delivered run (core `home-posts.ts`). The body is the chat brief (`chatSinkBody`), built even when
  the sprout has no chatops sink, never the full digest. `chatopsVerbatim` and
  `chatopsOnlyOnProblems` are chatops-only: Home still gets the brief and is never muted.
- `ttlMinutes` is 1 to `HOME_TTL_MAX_MINUTES` (a year), so `expires_at` stays a valid ISO date.
- Only the scheduler-lease holder inserts (`RoutineHostDeps.holdsLease` = the wiring's
  `canSchedule`), re-checked right before the insert: the brief's model call can outlive the lease. Stopped runs reach no sink, so they insert nothing.
- Body capped at `HOME_POST_MAX_CHARS` (= the renderer's `THREAD_TEXT_MAX`, keep in step) with a
  "full digest in Dashboard" tail, so a drained post is never cut twice.
- Pending = `drained_at IS NULL` and unexpired. Each insert keeps only the newest
  `HOME_PENDING_CAP` undrained rows and prunes drained rows after 30 days, so a core no shell ever
  drains stays bounded.
- `markHomePostsDrained` is idempotent (`WHERE drained_at IS NULL`), ignores unknown ids, and opens
  no transaction of its own, so the host can run it inside the transcript save's transaction.
- Not `sprout_dispatches`: posts have no origin conversation and never enter the chatops outbox.
