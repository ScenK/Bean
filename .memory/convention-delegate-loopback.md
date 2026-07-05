# Delegate loopback — the tracked exception to fire-and-forget

`propose_delegate` (converse, confirm-first like `propose_run`) hands a task to a headless
agent — `claude -p --output-format stream-json` with an explicit `--allowedTools` allowlist
(never `--dangerously-skip-permissions`) or `opencode run` — via core's `runDelegate()`
(`delegate.ts`, pure/DI, sibling of the untouched `launcher.ts`). Unlike Terminal launches,
Bean **does** track these: `app/src/delegate-tasks.ts` keeps a task registry and pushes
`started/output/done/failed/cancelled` over `bean:delegate-event` (Bean's first main→renderer
push channel) to the chat's DelegateCard.

Key contracts:
- **Loopback:** on `done` the renderer auto-sends `[delegate result for "…"]: …` through the
  normal chat flow (collapsed display label), so the model summarizes and the result enters
  history for chaining.
- **Tasks share the chat window's lifetime — no ghosts:** closing the chat with a running
  delegate shows a Keep working / Stop & close card (same pattern as the memory review),
  and main calls `cancelAll()` on chat-window `closed` as the hard backstop. The renderer only
  buffers delegate events until `delegateStart()` returns the task id, then replays them; a
  delegate never runs on without its human context.
- **Cancel waits for process close:** `DelegateHandle.cancel(onCancelled)` sends SIGTERM to the
  process group, escalates to SIGKILL if it does not close quickly, and only then lets the app
  registry emit `cancelled` and drop the task. Stray post-cancel callbacks are ignored.
- The delegate CLI is user-picked in Settings (`delegateCli`, "" = first detected); the chat
  model never chooses the harness.
