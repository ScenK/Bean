# Sprout dispatches (persisted origin, #919)

A sprout run started from a conversation is a row in `bean.db`'s `sprout_dispatches`
(`core/src/dispatch-store.ts`): surface, conversation (chatops channel, NULL = owner DM; desktop =
chat thread id), actor, sprout, optional todo id, run ids, terminal status, brief, delivery state.

- **Written only by the scheduler-lease holder.** `answerRoutineTrigger` refuses a run with
  `standby` when `held()` is false: the holder's `routine-wiring.ts` `start()` closes every open
  row as `interrupted` first thing (before any await), so a standby's row would be falsely
  interrupted. Nothing is ever re-run.
- **Run-linked rows** (`todo_id` NULL) close at the trigger's `done` (`withDispatch`); a brief is
  kept only when the trigger admitted exactly one run. **Todo-linked rows** close only in
  `updateTodoStatus` with that todo's own result, whichever run took it — `closeDispatch` skips
  them; at start they survive while their todo is still `pending`.
- **Delivery = sweep** (`deliverDispatches`): claim (`delivered_at` set) → deliver → un-claim on
  false/throw. Runs at start, after every run's digest, and at each dispatch's end. Claim-first
  means at-most-once: a crash between claim and the outbox write loses that notice. Desktop rows
  return false until #921 wires the loopback.
- `keep_brief = 0` (incognito desktop chat) → `brief` stays NULL. Delivered rows are pruned after
  30 days at start.
