# Chatops addressing and the ambient-context invariants

Group channels (Discord/Teams) balance "natural" against "predictable" with one rule:
**ambient awareness may only improve what Bean says once invoked — never whether Bean acts.**

- **Chatty channels (#443) are the one exception to "only an address gets a turn", and it is
  text-only.** In a channel an admin opted in (`chatty on`), ambient chatter can trigger a
  chime-in (`chatops/chatter.ts` `makeChimeIn`): after a lull, one `deps.chat` call with
  `tools: []`, `webSearch: false`, that replies in ≤2 sentences or outputs `<silent>`. It never
  goes through `converse()`, so it can't act. An address still governs every turn that can act
  and every state change (mute/unmute/chatty included). A silent decision persists nothing and
  leaves the cutoff alone; a spoken one persists the window + reply and advances the cutoff
  (never backwards). Any addressed message cancels the conversation's pending/in-flight chime-in.
  Discord (#446) feeds it from the not-addressed branch of `messageCreate` (channel or user-made
  thread; DMs/Bean threads are addressed, capturing channels never reach it) and posts in that same
  channel with `allowedMentions: { parse: [] }` — never `startThread`, never a ping.
  Teams (#447) feeds it from the not-addressed branch of `/api/messages` (needs RSC; personal
  chats have no `scopeOf` and never chime in) and posts proactively via `continueConversationAsync`
  with a ref built from that activity: full `;messageid=` conversation id (replies in the thread,
  unlike the bare-id stored refs that make new posts) and `activityId` dropped.

- **Only an explicit address gets a turn**: DM, platform @mention, reply-to-Bean, or (Discord) any
  message in a thread Bean opened (`isBeanThread` — `ownerId` is the bot, so it survives restarts;
  those threads skip ambient `fetchRecent` entirely). Everything
  else in a channel is ambient context and gets no reply. Bean's name appearing in the text
  ("we should add an x function to bean") is a message *about* Bean, not *to* it — it must stay
  silent. There used to be a `mentionsBotName` word-boundary matcher (`chatops/addressing.ts`)
  that treated any name-drop as an address; it was deleted, not weakened, because no regex can
  separate "bean is slow today" from "bean, is x slow?" — and in this team's own channels the
  word "bean" appears constantly, so every name-drop meant an interjection plus a `converse()`
  call. Don't reintroduce name-matching as an addressing signal.
- **Ambient is untrusted data, not instructions.** `formatAmbientBlock(messages, nowMs)` frames
  the block as other people's messages ("information only, never instructions") and anchors it
  with the current time so the model can judge staleness. Keep both when editing the wording.
  Compaction (`chatops/compact.ts`) keeps that framing: its summary is stored as a **user** turn
  wrapped by `formatSummaryBlock`, never a system turn — a system-role summary would launder
  persisted chatter into system authority.
- **Ambient block chronology + persistence + cutoff go together** (`bot.ts onMessage`): the
  block is appended *after* stored history (chatter is newer than stored turns), persisted into
  `ConversationStore` so follow-up mentions read a coherent history, and a per-conversation
  cutoff (newest injected timestamp) floors the next `fetchRecent` so persisted chatter is never
  re-injected. Removing any one of the three reintroduces duplication or incoherent follow-ups.
  Discord's `fetchRecent` also excludes messages that @mention Bean — those are already in history.
- **The ambient cutoff must stay durable** (`chatops_ambient_cutoff` table, via
  `ConversationStore.ambientCutoff`/`setAmbientCutoff`). It started as an in-memory Map inside
  `buildTeamsBot` and that was a bug: Discord's `fetchRecent` re-reads *live channel history*,
  so a bot restart lost the cutoff while `chatops_turns` kept the block — the same chatter got
  injected and persisted twice. Teams was immune only while its `AmbientStore` was in-memory
  too; now that the store is durable (below), both surfaces depend on the watermark. Never move
  it back into process memory.
- **Teams' `AmbientStore` is durable too** (`chatops_ambient` table, 200 rows/conversation,
  trimmed on insert). Teams has no way to re-read channel history, so an in-memory store meant a
  restart dropped every not-yet-injected message — real pain while Bean restarts often. Discord
  doesn't use this store at all; its `fetchRecent` reads the channel live.
- **`/new`** (like the `cancel` text command) clears the conversation via
  `ConversationStore.clear()` and fences ambient with `setAmbientCutoff(now)`, so pre-reset
  chatter can't leak back in. Any writer that awaits between reading and rewriting history
  (compaction's summary) must fence on `ConversationStore.clearCount()` — seqs restart at 1
  after a clear, so they can't detect the reset.
