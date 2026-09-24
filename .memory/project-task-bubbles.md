# Avatar status bubbles (design 2a)

While Bean works, a stack of speech bubbles floats above the avatar bean, one per job. The
newest sits nearest the bean and is the only one with a tail. Clicking a bubble expands it to
show the delegate's instruction or the routine's steps. Expanded bubbles are **read-only** by
decision: there's no Stop/Pause button, and a routine has no pause state to back one.

- **Sources: delegate tasks + routine runs only.** `main.ts` feeds `task-status.ts`
  (`upsert`/`finish`, where a finished job lingers 10s) from the delegate `send` wrapper and
  `runOneRoutine` (core `runRoutine`'s `onStep` hook). ChatOps activity is excluded because the
  bots are separate processes and the app only knows up/down. Showing it would need a new
  cross-process channel. Terminal launches stay untracked (convention-launch-hands-off-to-terminal).
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
- Guards: `task-status.test.ts`, the `statusLayout` + avatar-window unit tests, and
  `e2e/task-bubbles.e2e.ts` (bean doesn't move, text is escaped, window collapses back).
