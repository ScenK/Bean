# Delegate loopback — the tracked exception to fire-and-forget

`propose_delegate` (converse, confirm-first like `propose_run`) hands a task to a headless
agent — Claude, OpenCode, or Codex with the provider-specific argv from `delegateCommand()` —
via core's `runDelegate()`. True bypass is a deliberate decision
(2026-07, PR #77), same posture as live sessions: headless `-p` can't answer permission
prompts, an `--allowedTools` allowlist stalls unattended night routines on the first
non-allowlisted action, and `--permission-mode auto` is no middle ground because its
classifier doesn't run headless (verified on v2.1.214 — every would-ask action is denied,
even in-cwd writes). The confirm-first proposal card is the authorization boundary — since #1113
widened from one run to one **task**: a confirmed card's task grant lets that chat's follow-ups
resume the same session with no card (see `convention-delegate-task-grant.md`).
Revisit if a Claude Code release runs the auto classifier headless. `runDelegate()` lives in
`delegate.ts` (pure/DI, sibling of the untouched `launcher.ts`). Unlike Terminal launches,
Bean **does** track these: `host/src/delegate-tasks.ts` keeps a task registry and pushes
`started/output/done/failed/cancelled` over `bean:delegate-event` (Bean's first main→renderer
push channel) to the chat's DelegateCard.

Key contracts:
- **Loopback:** on `done`, `failed` and `cancelled` (#1113) the renderer auto-sends one outcome
  turn (deduped by settled task id) through the normal chat flow (collapsed display label), built
  by core's `delegateOutcomeTurn()` (`prompt.ts`, #1131): `[delegate result|failed|cancelled for
  "…"]: <reason>` + the agent's final message `quoteFence`d as data + a "judge it: done / partly
  done / blocked / waiting on the user; say what was done and what was skipped" ask — never a
  one-line status. `failed`/`cancelled` events carry `final` — core `runDelegate` hands it to
  `onError(err, final)` / `cancel((final) => …)` (the final answer a `FAILED:` is judged from, else
  the latest prose; `onText` alone misses claude/agy result events), trimmed and capped by `trimDelegateFinal`; the `FAILED:` sentinel asks the agent to list done/not-done
  under its first line. ChatOps appends the same `delegateOutcomeRecord()` (no ask) to history on
  every terminal outcome (`last` = core's final, else the latest prose), so the next turn can answer "what happened?", and
  Bean's outcome turn (#1133, `convention-delegate-task-grant.md`) judges it in place of the raw post. No partial state — `FAILED:` stays the only failure signal. A loopback turn (`source: "loopback"`) is offered the
  session only as a bounded **automatic follow-up** (#1132, see `convention-delegate-task-grant.md`):
  it names its `settledTask`, and the host admits it only for a run it saw settle in that chat —
  `source` alone authorizes nothing; it never refreshes the grant. A refused cardless resume doesn't
  loop back: a user's continuation re-offers its instruction as a normal card; Bean's own follow-up
  becomes a needs-you line instead (never a card). A delegate outcome queued behind the user's own
  turn still reports (Bean sees every outcome) but carries no `settledTask`.
- **Tasks live for the chat window, not the shown chat — no ghosts:** switching chats keeps a
  chat with a running delegate mounted, hidden (#517); every event carries the starting chat's
  `mountId` (stamped by `delegate-tasks` from the task, set by the host's `chat-sessions.ts`) and the shell routes it there,
  so the loopback runs in that chat at once. Closing the window with tasks in any chat shows one
  Keep working / Stop & close card counting them; main calls `cancelAll()` on chat-window `closed`
  as the hard backstop, and a chat's release `cancelMount`s its own. The renderer only buffers a
  chat's delegate events until `delegateStart()` returns the task id, then replays them; a
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
  the spawned harness is enabled and supports the model (or receives no `--model`). DelegateCard
  shows and sends the real pair: `cli` (its CLI pick, else that Settings preference + the
  remembered model as `lastUsed`) plus a model that CLI offers (`pickModel`). A request with
  `cli` runs exactly that CLI — `delegate-tasks.ts` fails the task, nothing spawned, when the
  resolve lands elsewhere (disabled since render). Never send a remembered model as an explicit
  `model` next to a picked CLI: an explicit model moves the run to whichever CLI offers it.
  Routine steps and the card-less path omit `cli` and keep the Settings preference.
- **The cwd is registry-checked in the host:** `delegate-tasks` `start` spawns only when
  `projectAllowed` (`host.ts`'s shared check, also used by live-tasks: Bean's scratch workspace or a
  `projects.json` path, re-read per start) passes; anything else fails the card with zero spawns
  (#588). The renderer's `projectPath` is never a trusted cwd — same rule as chatops cards.
