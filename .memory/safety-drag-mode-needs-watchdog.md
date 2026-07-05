# safety: drag mode must have a non-drag-event exit (the "app freeze" wedge)

The avatar's `"drag"` mode (URL dragged onto the bean, skill-tile bloom open) used to be
exitable **only** via drag events: `drop` on the bloom or an out-of-rect `dragleave`. This
transparent always-on-top window is known to drop terminal events (same reason the hover box
has a main-process cursor-poll backstop — see safety-window-behavior.md). When a drag ended
without either event, the avatar wedged permanently in drag mode: window stuck grown, the
window-sized `#bean-drag-bloom` overlay (`pointer-events: auto`) swallowing every click, no
handler responding. Users experienced this as "the whole app froze; only the tray works."

Three guards now prevent it (avatar.ts + drag-watchdog.ts) — don't remove any of them:

1. **Watchdog** (`createDragWatchdog`): every `dragenter`/`dragover` arms an ~800ms silence
   timer; if drag events stop arriving while mode is `"drag"`, collapse. Chromium re-fires
   dragover on a stationary target every ~350ms, so silence past that means the drag is gone.
   Both the bloom's and `#bean`'s dragover handlers must keep arming it — while a collapse is
   pending the bloom is `pointer-events: none` and dragovers land on `#bean` instead.
2. **Re-entry cancels a pending collapse**: `dragenter` while mode is still `"drag"` (a
   dragleave-triggered `collapse()` hasn't fired its 300ms timer yet) cancels the collapse and
   restores the bloom. Without this the window shrank mid-drag out from under the held cursor,
   and the eventual drop could land outside the resized window — the main way terminal events
   got lost.
3. **Manual escape hatch**: a plain click or Escape while mode is `"drag"` collapses (real
   clicks are impossible mid-drag, so one arriving means the mode is wedged).
