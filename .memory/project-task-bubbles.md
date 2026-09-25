# Avatar status bubbles (design 2a)

While Bean works, a stack of speech bubbles floats above the avatar bean, one per job. The
newest sits nearest the bean and is the only one with a tail. Clicking a bubble expands it to
show the delegate's instruction or the routine's steps. Expanded bubbles are **read-only** by
decision: there's no Stop/Pause button, and a routine has no pause state to back one.

- **Purpose: "Bean is alive / Bean is broken", not a mirror of any one window.** Sources:
  delegate tasks, routine runs, local chat turns (bubble while `converse()` runs, dismissed on
  reply — the chat window already shows it; "Drawing an image…" during image gen), and failures:
  `converse()` model errors (`ConverseResult.error`), chatops bot crashes, reminder delivery.
  Terminal launches stay untracked (convention-launch-hands-off-to-terminal).
- **Failures are sticky; done lingers 10s.** `finish(..., "failed")` keeps the bubble until the
  user clicks it open then clicks again (`bean:dismiss-task` → `dismiss()`); a user Stop passes
  `sticky=false`. Standalone errors go through `error(id, …)` with a stable id (`bot:discord`,
  `chat:error`, `reminder:error`) so repeats bump `count` ("failed ×3") instead of stacking.
- **ChatOps activity crosses the process boundary over Node IPC.** `chatops-servers.ts` spawns
  the bots with `"ipc"` in stdio; the servers pass core's `parentActivitySink` (a no-op when run
  standalone, and callback-form `process.send` so a closed channel can't crash the bot) as
  `onActivity` to `buildTeamsBot` (converse turns only — commands/live-session steering don't
  count), `RunRegistry` and `LiveSessionRegistry`. Main validates every message with
  `parseChatopsActivity` (string type/phase checked before the `Object.hasOwn` lookup — a
  crafted key object would throw in main — known values, 300-char caps) and `chatops-activity.ts` maps it to
  bubbles under `<bot>:<type>:<id>` ids. Privacy: sender + channel name and phases only —
  never message text, delegate output, or any error text (CLI stderr and thrown errors can quote
  messages or secrets; codex flagged each in turn). Failures show "… — details in Discord". When a bot stops, `clearBotJobs` closes its still-running bubbles ("Bot stopped").
- **At most 4 bubbles show** (`MAX_VISIBLE`, renderer-only); older ones fold into a
  `.bean-bubble-more` pill at the far end ("+3 more · 1 failed") that toggles them open. The
  failed count is load-bearing: sticky errors are usually the oldest jobs, and the cap must not
  hide them silently. A per-source Settings toggle was deliberately skipped — add it only if the
  bubbles prove noisy in real use.
- **The window grows; it isn't click-through.** The renderer reports the stack height
  (`bean:set-avatar-status-height`), and `avatar-window.ts` uses `statusLayout()` for
  `normal`/`hover` while the height is > 0. The window is then 300 × (stack + 120) with the bean
  44px from the right edge. It keeps `anchor` because the bean is no longer the window center.
  The transparent area blocks desktop clicks while jobs run, which is an accepted tradeoff.
- **Flip below near the screen top.** Bean's default spot is 160px from the top, so an
  above-only stack got clipped on first run. `statusLayout` flips it (`bubblesBelow`), and the
  renderer reverses the **DOM order** so the tailed newest bubble still sits nearest the bean.
  Don't use CSS `column-reverse` here: a scrolled stack would then open on the oldest job.
  `statusLayout` also sends `stackMax` (the room on that side), and past it the stack scrolls.
  Near the left edge, the bubble clamps inside the window and the tail slides over
  (`--bean-tail-right`).
- Menu/drag modes hide the bubbles with `opacity`, not `display:none`, so the measured height
  (and the window) doesn't jump under the tiles.
- Guards: `task-status.test.ts` (incl. sticky/merge), the `statusLayout` + avatar-window unit tests, and
  `e2e/task-bubbles.e2e.ts` (bean doesn't move, text is escaped, error click-to-dismiss, the 4-bubble cap + pill, window collapses back).
