# Home posts (`home_posts`, `sinks.home`)

Epic #958 (Home chat). Story #959 is the core half; #960 the Home thread and its drain; #961 the
unread dot, the avatar bubble and the jump-down pill; #962 the sprout-editor controls.

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

## Home thread (#960)

- Today's Home id = `homeThreadId()`: a UUID-shaped sha256 of the **core-local** date (no stored
  state, every shell agrees). The shell asks for it as `chatThreadGet("home", mount)` — it can't know
  the core's date — and gets an empty thread before the first save, plus `home: { posts, until }`.
  Earlier days' Home threads are plain history (deletable, never drain); the listing flags only
  today's with `home: true`, which the sidebar pins instead of dating.
- Drain = the save that holds the posts: the host reads the `post` items in the saved transcript
  (no id list from the shell; only items with every field the shell's restore keeps — host
  `postShape` and chat-thread.ts `normalizeItem` stay in step) and drains those it handed **to that mount with that thread**, via
  `saveDesktopChatDraining` (save + mark drained in one `BEGIN IMMEDIATE`). A failed save leaves them
  pending; the renderer appends by post id, so a re-hand never doubles. Past midnight a save of
  yesterday's Home holding undrained posts is refused (today's Home owns them); the renderer drops
  them at its day timer. A shown Home appends main's current pending list, re-asked on every show, so
  a post that expired while it was hidden stays out. The host never appends to `items_json`.
- The renderer appends posts only while the chat is shown (a hidden Home waits), adds no model turn,
  and maps a `post` item into history as a `[sprout "<name>" posted]: <<<…>>>` user turn with source
  `loopback` (non-typed); it's left out of the close-time memory transcript.
- Home is never deleted/starred/renamed/grouped (host throws) or taken off the record (host
  `setIncognito` ignores it; the shell's Off the record opens a separate incognito chat).
- Midnight with Home open: the chat stays on that thread (now plain history) with a status row. The
  chat window re-reads the listing's `home` flag on focus and every 10 minutes (it can't know the
  core's date), so yesterday's row drops into history.

## Unread dot, avatar bubble, jump-down pill (#961)

- **The pending count is the only source of truth.** The bubble, the Home row's dot and the pill show
  while it's above zero; nothing hides them by which chat is visible, and nothing pushes posts into an
  open Home. Any delivery failure leaves an indicator on screen instead of losing a post. Don't bring
  back live push / seen-tracking / visibility-aware drains: four review rounds each found a new
  silent-loss P1 there (slow remote save, minimized window, standby host, restore race, reattach).
- The bubble is one job `home:posts` (kind `home`, state `done` — never `running`, so no spinner,
  Stop, keep-awake or update block; `count` = pending posts), built by `homeJob()` in
  `task-status.ts`. Host `home-bubble.ts` recounts it on insert (`RoutineHostDeps.onHomePost`, lease
  holder only), on a draining save (`onDrained`), at boot, at the soonest pending expiry, and every
  `HOME_RECONCILE_MS` (a standby host's only way to see the holder's posts). Its click opens Home and
  never dismisses it.
- Drain happens only when Home is **opened**: shown, picked again (row, bubble, banner, avatar), or the
  pill clicked (`ChatPanel` `homePosts`: the `bean-jump-down` pill shows even at the bottom). Each asks
  `chatThreadGet("home")`; a failed read appends nothing and a failed save drains nothing, so the count
  stays and the next open retries (an open with nothing new re-saves).
- Remote shell: no job feed, so `createRemoteHomePoll` (remote-core.ts) reads `homePending` on
  attach, every `HOME_POLL_MS` and after a `chatThreadSave`; only the latest read's reply counts.
  Main broadcasts `[homeJob(n)]` as the whole job list.
- "Open on Home": main's `openChatHome` (bubble, a sprout banner with `meta.open: "home"`, and the
  avatar's plain open-chat when a fresh `homePending` read is positive) pushes `chatShowHome` to an
  open window and leaves `getPendingChatHome` for one still loading. Main also replays the job list
  once the avatar has loaded — boot jobs were otherwise pushed to nobody.

## Sprout editor (#962)

- "Post to Home chat" under DIGEST SINKS writes `sinks.home: {}`; the nested minutes field sets
  `ttlMinutes` (blank = keep). An invalid number stays in the draft so core's
  `describeRoutineError` refuses the save with its message — no renderer-side copy of the rule.
- Every sink rewrite keeps `home`: `cleanChatSinks` and the panel's spreads, and an owner's chat
  replacement of a sprout copies it from the saved file (`bot.ts`; the draft tool has no Home
  field). The builder brief can't set Home (`cleanSinks` drops it); turn it on in the editor.
- Named in the builder review (`destinations()`), the run card's "results go to"
  (`sprout-trigger.ts`) and the editor footer. e2e: `routine-sinks.e2e.ts`.
