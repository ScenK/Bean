# Outbox messages are not chat context unless flagged

A routine digest delivered to a Discord/Teams conversation is **not** in that conversation's
history by default, so a follow-up question about it ("what did step 2 mean?") reaches a bot
with no idea what you're referring to. Three independent gaps produce that, and all three are
deliberate:

1. `deliverDigest` (`app/src/main.ts`) enqueues an `OutboxMessage`; it never goes through
   `chatops/`'s conversation layer.
2. Each bot's outbox drain only appends to `ConversationStore` when the message says to.
3. Discord's ambient `fetchRecent` filters `!m.author.bot`, so Bean's own post is not ambient
   context either.

The opt-in is `OutboxMessage.context` (core `outbox.ts`), set per message by the enqueuer from
the `routineDigestContext` config flag (Settings → Chat bots, default off). It is read **live**
via `runtime.getRoutineDigestContext()` at enqueue time, so the bot servers — which load
`~/.bean/config.json` once at boot — need no restart when the toggle flips. Don't "simplify"
this by having the bots read the config themselves; that reintroduces the restart.

`displayBody` is the separate, unconditional append path (interrupted-run notices, whose `body`
is model-facing). The two are mutually exclusive by convention; Teams' trailing append guards
on `!msg.context` so a message carrying both can't double-write.

Delivery-side appends go through each server's local `appendDelivered`, which also fires
`maybeCompact` — `bot.ts` only compacts after an *inbound* turn, so a channel that merely
receives digests would grow unbounded. `maybeCompact` is serialized per conversation
(`chatops/compact.ts`) because it now has several fire-and-forget callers: two overlapping
passes both snapshot the same oldest 40 turns and the second `replaceOldest` deletes the
first's summary plus every newer turn — 22 turns collapsed to 1 in the regression test.
Serialization is in-process only; see the `ponytail:` note there.

Default is off on purpose: every digest kept as context costs tokens on every later turn in
that conversation, including the ones nobody asks about.
