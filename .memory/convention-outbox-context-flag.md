# Outbox messages are not chat context unless flagged

An outbox message delivered to a Discord/Teams conversation is **not** in that conversation's
history unless flagged, so a follow-up question about it ("what did step 2 mean?") would reach a
bot with no idea what you're referring to. Three independent gaps produce that, and all three are
deliberate:

1. `deliverDigest` (core `routine-host.ts`) enqueues an `OutboxMessage`; it never goes through
   `chatops/`'s conversation layer.
2. Each bot's outbox drain only appends to `ConversationStore` when the message says to.
3. Discord's ambient `fetchRecent` filters `!m.author.bot`, so Bean's own post is not ambient
   context either.

The opt-in is `OutboxMessage.context` (core `outbox.ts`), set per message by the enqueuer.
**Sprout digests always set it** (`deliverDigest`, #1066) — channel, alias, owner-DM and
member-DM sinks alike, so a member-DM digest sits in that member's own history. The old
`routineDigestContext` setting is gone; an older config or peer that still carries the key is
accepted and ignored (dropped on the next config save). The owner's daily **memory digest**
(`host/memory-digest.ts`) sends `context: false`: it is private recall material, not something
to follow up on. Keep the decision at enqueue time, not in the bots.

**Exception — Teams channel posts.** A digest sent to a bare Teams channel id starts a new
post, and replies in its thread arrive as `<channel>;messageid=<post id>`. The drain keeps
`sendActivity`'s returned id and always saves the posted text under that thread key, whatever
`context` says (`deliveredAppend` in `teams/src/teams-config.ts`): a reply in that thread is
an explicit follow-up, and nothing else ever reads the key, so it costs no tokens elsewhere. No
returned id = logged and not saved, never the bare key. Thread (`;messageid=`) targets, DMs,
and group chats follow the flag as below.

`displayBody` is the separate, unconditional append path (interrupted-run notices, whose `body`
is model-facing). A sprout dispatch notice (#920) carries both — `context: true` plus a
`displayBody` — since its saved `body` is the fenced brief; every drain branch still appends
`body` exactly once per delivery, so a message carrying both can't double-write.

Delivery-side appends go through each server's local `appendDelivered` (core `appendDelivery`;
an owner-DM delivery joins the main log after the cutover, #998), which also fires
`maybeCompact` — `bot.ts` only compacts after an *inbound* turn, so a channel that merely
receives digests would grow unbounded. `maybeCompact` is serialized per conversation
(`chatops/compact.ts`) because it now has several fire-and-forget callers: two overlapping
passes both snapshot the same oldest 40 turns and the second `replaceOldest` deletes the
first's summary plus every newer turn — 22 turns collapsed to 1 in the regression test.
Across processes (#996) `replaceOldest` is a compare-and-swap on the snapshot, so the stale pass
skips instead; the in-process queue only saves the wasted summary call.

Cost: every digest kept as context costs tokens on later turns in that conversation;
`maybeCompact` (above) bounds it.

**Logging.** Bot outbox failure logs go through core `outboxErrorLine(err)` (name + message):
platform errors carry the request body (DiscordAPIError `requestBody`), and an outbox body can be
private — the owner's daily memory digest (#859). Never log the raw error object there.
