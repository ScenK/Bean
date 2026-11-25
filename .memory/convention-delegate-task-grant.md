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
  release. Busy = `delegateTasks.busy` or `liveTasks.holds` on the session id. A match starts the
  run before the chat reply returns (`continuedDelegate`); the renderer replays its buffered
  events. The card's grant line follows the host's `granted` flag on settled events — never saved.
