# Sprout dispatches (persisted origin, #919)

A sprout run started from a conversation is a row in `bean.db`'s `sprout_dispatches`
(`core/src/dispatch-store.ts`): surface, conversation (chatops channel, NULL = owner DM; desktop =
chat thread id), actor, sprout, optional todo id, run ids, terminal status, brief, delivery state.

- **Written only by the scheduler-lease holder.** `answerRoutineTrigger` refuses a run with
  `standby` when `held()` is false: the holder's `routine-wiring.ts` `start()` closes every open
  row as `interrupted` first thing (before any await), so a standby's row would be falsely
  interrupted. Nothing is ever re-run. Exception: a todo-linked row inserted **in one transaction
  with its pending todo** (`queueTodoDispatch`) — start keeps those — so any process (a bot, a
  standby desktop) may write one.
- **Run-linked rows** (`todo_id` NULL) close at the trigger's `done` (`withDispatch`, which asks
  the scheduler for the run's brief); a brief is kept only when the trigger admitted exactly one
  run. **Todo-linked rows** close only in `updateTodoStatus`, in the same transaction as the todo,
  with that todo's own result, whichever run took it — `closeDispatch` skips them; at start they
  survive while their todo is still `pending`.
- **Delivery = holder-only sweep** (`deliverDispatches`): claim (`claimed_at`) → hand off → mark
  `delivered_at`; false/throw releases the claim. A crash mid-hand-off leaves the claim, which the
  next holder's start releases (so `deliver` must be idempotent per job id). Chatops hand-off is
  `enqueueDispatchNotice`: outbox message id = job id (a repeat rewrites the still-queued file; a
  `.sending` one is skipped); one already sent can repeat — the outbox's own at-least-once.
  Runs at start, after every run's digest, and at each dispatch's end.
- **Desktop chats (#921).** A sprout card's Run is `chatSproutRun` (host `chat-sessions.ts`
  `sproutRun`): lease holder only, answers at admission with the job id (`withDispatch` returns
  `jobId`), conversation = the chat's thread id (an off-the-record chat sends a per-chat UUID
  that's never saved; `keepBrief: false`). Hand-off = `deliverSprout`: a mount-tagged `sprout`
  push to the chat that started it (in-memory thread → mount, for unpinned threads) or the chat
  that has the thread pinned; no chat → false (owed) while `desktop_chats` has the thread, else
  dropped (true). A restore is the other half: `threadGet` returns the thread's dispatches
  (`sprouts`; closed ones marked delivered), so a running card (saved with its `jobId`) settles
  from the real row even if a push was lost. The renderer settles the card and loops
  `[sprout result for "…"]` back through `queueIfBusy` once per job (a settled card ignores
  repeats); a running sprout card is chat work (stays mounted). No Stop on the card.
- **Remote shells (#922).** `chatSproutRun` is the one routines-side `REMOTE_OPS` entry (the
  contract test pins it; `routines*` stay default-deny, so a remote *check* card still fails).
  `sproutRun` also pushes the admission (`{ mountId, jobId, name }`, no `status`; the renderer
  ignores it): a start whose reply a drop lost is an orphan in `remote-core.ts` and resolves from
  it, like a delegate's `started`. Ends ride the attachment's per-mount replay (not `output`, so
  never evicted).
- `keep_brief = 0` (incognito desktop chat) → `brief` stays NULL. Delivered rows are pruned after
  30 days at start.
- **The chatops notice is chat context (#920).** `enqueueDispatchNotice` posts the finish line +
  brief (`displayBody`) and saves `dispatchContext` — the brief fenced as run output — with
  `context: true`, like every sprout digest. The bot appends to the conversation key
  at delivery, so a `/new` mid-run lands it in the fresh history.
- **Sink skip.** A triggered run carries its chat origin (`RunOpts.origin`) to `deliverDigest`,
  which drops chat sinks that resolve to it (`sameChatTarget`: transport + resolved conversation;
  no channel on both = owner DM, except a Discord `user` sink). A run that took todos
  (`RoutineRunResult.todoIds`) instead skips only conversations every one of its todos was
  dispatched from (`todoDispatchOrigins`) — so a drain started from a card still reaches its sinks.
  The saved sprout is never changed.
- **Todo cards: Run now / Queue (#923).** Both actions queue via `queueTodoDispatch` (todo + its
  dispatch row; Run now at the front, lowest `ord`). Run now then asks the holder's
  `scheduler.runTodo(name, todoId)`: a free slot runs exactly that todo (`claimTodoById`, a
  `worker` with one claim and no post-run poll/drain) → `started`; every slot busy → `next` (it's at
  the front, so the running drain/worker claims it; an in-memory `waiting` list runs it on the next
  freed slot if the busy run was itself an exact one). Never interrupts. Bots send only the job id
  (`routine-trigger` action `todo`, `job`), never the task text; `answerTodoRun` reads the row.
  Run now is owner-only (`cardActionNeeds("run-todo")` = owner, re-checked before the claim).
  A member's DM queues **without** a row (no member-DM destination). Cancel/delete of a pending
  todo deletes its open row (else a restart would report it "interrupted"). Desktop: the todo card
  keeps `jobId`, settles via the same `sprout` push/restore as a sprout card (`chatTodoDispatch`,
  a `REMOTE_OPS` entry; no orphan matching for it on a dropped remote reply).
- **`background_work` (#924).** Read-only action tool (core `background-work.ts`): live run slots
  (scheduler `runningNames`/`runningCount`, lease holder only — else `"unknown"`), open todo counts,
  this conversation's dispatch rows (`conversationDispatches`; unset conversation = the owner DM)
  with state/queue position/brief, each sprout's last run. A spawned bot gets the live counts over
  the IPC slot (`routine-running` → `routine-running-result`, request id only; no answer in 5s =
  unknown). Same gate as `list_todos`; a non-owner sees only `myTodos` + jobs they tapped or queued
  (never counts across people, last results or anyone else's text), and a member DM reads no rows.
  Desktop: owner view, rows of the chat's pinned thread + threads it dispatched from.
- **A failure gets one diagnosis turn (#1136).** `OutboxMessage.diagnose` is set at enqueue (dispatch
  notice with status failed/needs-attention; a chat sink's digest unless ok, stopped or a member-DM
  `user` sink — Home phone copies never). After delivering it (and saving it as context) the bot calls
  `bot.onSproutFailure` in the background: the owner as actor (no owner set = no turn), deduped by
  delivery id, `read_sprout` plus only that sprout's Run now / `propose_skill` / `propose_routine`
  (no delegate), one reply + at most one card. Discord sends both as replies to the notice; Teams posts
  into the notice's reply chain (`deliveredAppend`'s key). Never a rerun without a tap. Desktop: the
  sprout loopback asks `sproutFailureAsk` (core `prompt.ts`) instead of "briefly summarize".
