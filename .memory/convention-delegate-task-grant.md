# Delegate task grant + strict resume (epic #1111)

A confirmed delegate card authorizes one **task**: `delegate-grant.ts` (core, pure, memory-only)
scopes a follow-up that continues the same agent session without a card to surface + scope key
(desktop mount / real chatops conversation id) + confirming actor + project, CLI, model, skill and
browser, with a 30-minute idle expiry and a generation bumped on every new grant in a scope.
Omitted request selectors inherit the grant; a named one must match. Any mismatch → the normal
card plus `GRANT_MISMATCH_TEXT[reason]`. Restart drops grants (fail closed).

- `converse()` sees the session only via `activeSession` (cli, project name, last instruction,
  JSON-quoted user-role data); never a session id or path, never in the leading system message.
  `propose_delegate.continue` exists only when `activeSession` is passed.
- A cardless continuation must run with `strictResume: true`: `runDelegate` and
  `RunRegistry.start` refuse (`resumeRefusal`) instead of every fresh fallback (rejected id, agy
  non-UUID/new conversation, codex plan, other project, busy thread), and the started session id
  must equal `resume`. Don't add a fresh retry under strict — "never start fresh" is the
  authorization boundary. Verified 2026-11: `claude -p --resume <id>` keeps the same session id.
- Desktop (#1113): grants live in `host/src/chat-sessions.ts`, one per chat mount, created when a
  confirmed `delegateStart` reports a valid session (`delegate-tasks` `onSession`), refreshed when
  a run on it settles, revoked by Dismiss / End (`delegateRevoke`, a REMOTE_OP), dropped at mount
  release. Busy = `delegateTasks.busy` (a continuation reserves its id from the call, before its
  async checks) or `liveTasks.holds`; `liveResume` refuses a delegate-held id too — check both
  directions. A match starts the run before the chat reply returns (`continuedDelegate`); its
  `started` push also carries the card (`continued`), so a remote shell whose reply was lost still
  gets it from the reconnect replay (`adoptContinued`, idempotent by task id). The card's grant line follows the host's `granted` flag on settled events — never saved.
- ChatOps (#1114): grants live in `chatops/bot.ts`, keyed by the real conversation id (never
  `historyId()`'s `main`), actor = the confirming tap's platform `fromId` (never the display name).
  Created when a confirmed run settles with a session unless `/new` ran since the card tap (counted
  at `onCardAction` entry, before any await — not at launch); a continuation
  that settles on its session refreshes it, one that doesn't revokes it; a settle checks the
  generation it started on, so a late completion can't touch a revoked or newer grant. `/new`
  revokes and counts as a reset (the owner DM too, though its history doesn't reset). Offered to
  `converse()` only when the speaker matches; a continuation re-checks the grant, the CLI's presence,
  the skill's browser and busy (`RunRegistry.busy` + a bound live session), then posts the compact
  running card (no Cancel until it has a run id) and sends `composedPrompt` with `strictResume`.
  Else the normal card with `GRANT_MISMATCH_TEXT` and `PendingProposal.fresh`. After the last await
  (the card post), right before dispatch, it checks again: the speaker's current role, the grant's
  generation/revocation, a live session bound meanwhile, and the reloaded skill's browser — any
  change refuses visibly, never runs. A lapsed grant (idle, `/new`) also says
  why on the speaker's next card. Role is the per-turn `permitted("delegate")` gate, not a grant field.
