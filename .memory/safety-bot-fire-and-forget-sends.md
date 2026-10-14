# Bot fire-and-forget sends must `.catch`

The Teams/Discord bot servers have no `unhandledRejection` handler, so any un-awaited send
that rejects kills the process — and a restart wipes every in-memory proposal store, so
already-posted cards answer "That proposal expired".

- Never `void somePromise()` a send/update in a bot or `chatops/` callback. Use
  `.catch(() => {})` (typing pings) or `.catch(logRunEffectError)` (anything worth logging).
- Teams: a `TurnContext` is revoked when its turn handler returns. A send still in flight at
  that moment throws `Cannot perform 'set' on a proxy that has been revoked`. Anything that
  outlives the turn goes through `continueConversationAsync` (the `proactive` helper).
