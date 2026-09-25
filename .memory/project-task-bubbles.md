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
- **Plan — remaining phases (ChatOps activity):** bots are separate processes, so (2) add
  `"ipc"` to the spawn stdio in `chatops-servers.ts` and let the servers `process.send?.()`
  an activity event from an optional core `onActivity` dep (bot turn start/end, `RunRegistry`
  run lifecycle, live sessions, handler errors); main validates the shape. Verify dev + packaged.
  (3) map it to bubbles — sender + channel only, never message text; throttle run tails.
  (4) cap simultaneous bubbles, extend `e2e/task-bubbles.e2e.ts`, update this entry.
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
  `e2e/task-bubbles.e2e.ts` (bean doesn't move, text is escaped, error click-to-dismiss, window collapses back).
