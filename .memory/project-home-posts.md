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

## Home thread (#960, continuous since #976)

- Home is **one continuous thread**: `HOME_THREAD_ID` (core `desktop-chats.ts`) is a fixed UUID-shaped
  sha256 of a constant — no date, no stored state, every shell agrees. The shell asks for it as
  `chatThreadGet("home", mount)` and gets an empty thread before the first save, plus `home: { posts }`.
  The listing flags it `home: true`; the sidebar pins it.
- **Named after the persona (#1001):** get and list title it with the persona's name (host
  `personaName`, a sync read), whatever title it was stored under; ids (`home`, `sinks.home`) stay.
  The renderer's labels (sidebar, empty state, sprout editor, trim notice) re-read `getPersona` on
  mount and window focus (`usePersonaName`), so a rename shows at the next focus, remote too; the
  avatar bubble is named after it on each recount (and on a persona save). User-facing copy says
  "your chat with <name>", never "Home".
- It never rolls over: no midnight timer, status row or listing re-check (they were the daily Home's,
  #960 had no product reason for the roll). Its model history is bounded by the rolling summary
  (#975, `project-desktop-chat-compaction.md`), its transcript by the save trim.
- Exempt from the 90-day prune (`listDesktopChats` skips `HOME_THREAD_ID`); it still can't be starred.
- Pre-#976 daily Home threads ("Home · Nov 19") stay plain history: listed with their dated titles,
  deletable, never drained into, never merged. They age out normally.
- Drain = the save that holds the posts: the host reads the `post` items in the saved transcript
  (no id list from the shell; only items with every field the shell's restore keeps — host
  `postShape` and chat-thread.ts `normalizeItem` stay in step) and drains those it handed **to that mount with that thread**, via
  `saveDesktopChatDraining` (save + mark drained in one `BEGIN IMMEDIATE`). A failed save leaves them
  pending; the renderer appends by post id, so a re-hand never doubles. A shown Home appends main's
  current pending list, re-asked on every show, so a post that expired while it was hidden stays
  out. The host never appends to `items_json`.
- Bounded on screen too: `boundLive` (chat-thread.ts) trims a mounted chat past `THREAD_ITEMS_MAX +
  THREAD_LIVE_SLACK` back to the cap — never an unsettled card, an undrained post or the latest
  summary. It runs from ChatSession's save effect as a **functional** `setItems`: a plain set from
  the render's snapshot clobbered a reply queued meanwhile (the turn hung on "Spinning up").
- Once a trim (save or live) drops anything, a `status` row with `TRIM_NOTICE` ("Older messages aren't
  kept here — Bean remembers what mattered.") leads the transcript, counted in the caps, kept through
  every later save. Not model history (status rows never are).
- Perf (#976 e2e, `chat-history.e2e.ts` "full Home"): a restored 500-item / ~1.9 MB Home opens in
  ~0.7 s, scrolls at ~15 ms/frame, saves in well under 2 s; no `content-visibility` needed.
- The renderer appends posts only while the chat is shown (a hidden Home waits), adds no model turn,
  and maps a `post` item into history as a `[sprout "<name>" posted]: <<<…>>>` user turn with source
  `loopback` (non-typed); it's left out of the close-time memory transcript.
- Home is never deleted/starred/renamed/grouped (host throws) or taken off the record (host
  `setIncognito` ignores it; the shell's Off the record opens a separate incognito chat).

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
- "Open on Home": main's `openChatHome` (bubble, a sprout banner with `meta.open: "home"`, and —
  since #1001 — **every** plain open-chat from the avatar) pushes `chatShowHome` to an
  open window and leaves `getPendingChatHome` for one still loading. Main also replays the job list
  once the avatar has loaded — boot jobs were otherwise pushed to nobody.
- Since #1001 the main conversation is the avatar's default (its Chat tile and a double-click on the
  bean, `avatar.ts` `dblclick`), so it's never where a pushed prompt (even Add to current chat / the
  blank-chat fast path) lands when shown: that opens a task chat (`ChatWindow` `runPushedPrompt`); on
  a task chat, Add to current chat still adds to it. A drop on the avatar (`takeDrop`) always starts
  a task chat unless the shown one is an unused task chat. The persona is read over the wire
  (`getPersona` is a remote op); it's never written remotely. An e2e spec about a task chat opens
  one with `e2e/fixtures/task-chat.ts`'s `startTaskChat`; in e2e the empty bubble stack covers
  `#bean`, so avatar gestures are dispatched, not mouse-driven.

## Sprout editor (#962)

- "Post to your chat with <name>" under DIGEST SINKS writes `sinks.home: {}`; the nested minutes field sets
  `ttlMinutes` (blank = keep). An invalid number stays in the draft so core's
  `describeRoutineError` refuses the save with its message — no renderer-side copy of the rule.
  Malformed text ("-") reads as `""` with `validity.badInput`: it's stored as NaN, never as blank.
- Every sink rewrite keeps `home`: `cleanChatSinks` and the panel's spreads, and an owner's chat
  replacement of a sprout always takes it from the saved file, ignoring any `home` in the draft
  (`bot.ts`; `propose_routine` parses JSON, so a draft can carry one). The builder brief can't set Home (`cleanSinks` drops it); turn it on in the editor.
- Named in the builder review (`destinations()`), the run card's "results go to"
  (`sprout-trigger.ts`) and the editor footer (as a brief target unless the sprout is stepless). e2e: `routine-sinks.e2e.ts`.
