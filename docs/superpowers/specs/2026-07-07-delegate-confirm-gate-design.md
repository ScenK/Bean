# Delegate flow: fix the confirm gate

## Problem

The user reported that when they ask Bean to delegate a background task, the model
asks "Want me to delegate this?" in chat, and the task appears to start immediately
after — with no perceived button click. The intended UX is the opposite: the model
should propose delegation without asking permission in chat text, while the actual
run must wait for an explicit user click on the `DelegateCard`'s "Delegate" button.

Investigation found two distinct issues:

1. **A real bug**, not a misunderstanding: `packages/app/src/renderer/components/chat/ChatWindow.tsx`
   pushes new delegate proposal items with `state: "starting"` (`addDelegateProposal`,
   line 36-38) and, in the same `sendMessage` turn, schedules
   `queueMicrotask(() => void startDelegate(...))` (line 192-197) — unconditionally
   starting the background agent the instant `converse()` returns a `proposedDelegate`.
   `DelegateCard`'s "Delegate" button is `disabled={!pending}`
   (`DelegateCard.tsx:74`), and `pending` requires `state === "pending"` — a state
   this code path never produces. So the button was never clickable for a fresh
   proposal; `confirmDelegate` (the intended confirm-gated entry point,
   `ChatWindow.tsx:248-254`) is dead code in this flow. Git history shows this was
   introduced by a follow-up commit ("auto start delegate proposals") in the same PR
   that added the "confirm-first" `propose_delegate` tool — an internal contradiction,
   not intentional design.

2. **Redundant conversational confirmation**: `packages/core/src/converse.ts`'s
   `BEHAVIOR_INSTRUCTIONS` (line 51-57) and `proposeDelegateTool()`'s description
   (line 128-131) tell the model the flow is "confirm-first," which the model reads
   as its own job — so it asks the user for permission in chat text before even
   calling the `propose_delegate` tool. This is redundant once the UI card itself is
   the real confirmation gate (item 1) and should be removed.

## Fix

### 1. Make the button the real gate

In `packages/app/src/renderer/components/chat/ChatWindow.tsx`:

- `addDelegateProposal`: initialize new items with `state: "pending"` instead of
  `"starting"`.
- `sendMessage`: remove the `delegateToStart` variable and the
  `queueMicrotask(() => void startDelegate(...))` call. Just push the pending item,
  matching how `proposedRun`/`proposedNote` items are already handled (pushed with
  `state: "pending"`, no auto-start).

No changes needed to `DelegateCard.tsx`, `confirmDelegate`, or `startDelegate` —
they already implement the correct confirm-then-start behavior; they were simply
unreachable for fresh proposals.

### 2. Stop the model from asking permission in chat text

In `packages/core/src/converse.ts`:

- Reword the delegate-related guidance in `BEHAVIOR_INSTRUCTIONS` to instruct the
  model to call `propose_delegate` directly when the user wants project work done,
  without first asking "want me to do this?" in prose — the resulting card is the
  confirmation step.
- Reword `proposeDelegateTool()`'s `description` field similarly, since this text is
  visible to the model at call time and currently reinforces the "ask first" framing.

Scope: `propose_delegate` only. `propose_run`'s existing text/behavior is untouched.

## Testing

- `packages/core`: check `converse.test.ts` (or equivalent) for existing assertions
  on the old delegate instruction wording; update if any exist. Add/confirm coverage
  that `propose_delegate` tool calls still produce a `proposedDelegate` result
  correctly (prompt wording itself isn't meaningfully unit-testable).
- `packages/app`: add/update a renderer test (if a test harness exists for
  `ChatWindow.tsx`/`chat-types.ts` helpers) asserting `addDelegateProposal` produces
  `state: "pending"` and that `sendMessage` does not trigger `delegateStart` before
  `confirmDelegate` is called.
- Manual smoke test in the running app: ask Bean to delegate a task in a linked
  project, confirm the model does not ask a conversational "want me to?" question,
  confirm the `DelegateCard` renders in `pending` state with an enabled "Delegate"
  button and editable prompt, and confirm the background agent only starts after
  clicking it.
- Run `pnpm test && pnpm typecheck` per repo convention before considering this done.

## Out of scope

- `propose_run` / `ProposalCard` flow — already correctly confirm-gated, not part of
  this fix.
- Any change to `runDelegate()`, `delegate-tasks.ts`, or the IPC layer — the bug and
  fix are entirely in the renderer's state initialization and the model's prompt.
