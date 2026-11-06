# Sprout run Stop is per-run, not shutdown

`scheduler.stopRuns(name)` aborts that sprout's live runs through per-run `AbortController`s
(registered in `fill()` before `stamp()`/claims, dropped when the run/worker settles).
`scheduler.stop()` is still app/bot **shutdown** — don't overload it.

- The signal rides `deps.runRoutine(routine, todo?, signal)` → `runOneRoutine` → runner
  `deps.signal` → `DelegateStepRequest.signal` / `CommandStepRequest.signal`.
- `DelegateHandle.cancel(done)` settles **only** `done` (never `onDone`/`onError`), so the
  routine delegate adapter's `done` must `cleanup()` (release the run record) and reject —
  otherwise the step promise hangs forever.
- A killed command rejects (`Stopped by you`), never resolves `exit 137`: a gate would read
  that as FAIL and `onFail.goto` would loop. The runner also checks the signal after each
  commit, before gate/route handling, as a second fence.
- A stopped result (`RoutineRunResult.stopped`) is recorded (status `failed`, fixed digest
  "Stopped by you at step N (label)" + resume footer) but goes to **no sink** and triggers no
  watch post-run poll. A stop landing after the step loop/drain finished is ignored.
- Desktop: `bean:routine-stop` (handler ignores non-strings and idle names) → `routineBubbles.stopping`
  + `stopRuns`. Stop lives on the avatar bubble and the Sprouts panel; the chat sprout card reads
  `runNow`'s `{ status, stopped }` to say Stopped / Failed / Needs attention / Finished.
