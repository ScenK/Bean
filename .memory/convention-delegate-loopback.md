# Delegate loopback — the tracked exception to fire-and-forget

`propose_delegate` (converse, confirm-first like `propose_run`) hands a task to a headless
agent — Claude, OpenCode, or Codex with the provider-specific argv from `delegateCommand()` —
via core's `runDelegate()`. True bypass is a deliberate decision
(2026-07, PR #77), same posture as live sessions: headless `-p` can't answer permission
prompts, an `--allowedTools` allowlist stalls unattended night routines on the first
non-allowlisted action, and `--permission-mode auto` is no middle ground because its
classifier doesn't run headless (verified on v2.1.214 — every would-ask action is denied,
even in-cwd writes). The confirm-first proposal card is the authorization boundary.
Revisit if a Claude Code release runs the auto classifier headless. `runDelegate()` lives in
`delegate.ts` (pure/DI, sibling of the untouched `launcher.ts`). Unlike Terminal launches,
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
  **Codex is the exception: it gets SIGINT, not SIGTERM** (cancel, timeout, and the
  `killAllDelegates()` quit sweep, which also leaves a detached `sleep 3; kill -KILL` watchdog).
  Codex runs each tool command in its own process group, so a group SIGTERM/SIGKILL orphans
  the command; only SIGINT makes codex reap it. Don't "unify" the signals back (#237).
  **opencode reaps its tool groups on neither SIGTERM nor SIGINT** (#246), so its stops use
  `kill-tree.ts`: snapshot the descendants' pgids (`ps`) *before* the first signal, signal every
  group, and `escalateKill()` the saved set with SIGKILL after 5s — a timer that must NOT be
  cleared on close (opencode exits at once; the tool doesn't). Codex's SIGKILL backstop uses the
  same saved set. `killAllDelegates()` / `LiveSessionRegistry.forceKillAll()` sweep pending
  escalations (`killPendingGroups()`). Claude keeps the plain group kill.
- The delegate CLI preference is user-picked in Settings (`delegateCli`, "" = first enabled).
  `resolveCliModelSelection()` resolves that preference together with any requested model, so
  the spawned harness is enabled and supports the model (or receives no `--model`). Only a
  model the user explicitly clicks may override that CLI preference: DelegateCard's implicit
  display default must not be sent as a requested model.
