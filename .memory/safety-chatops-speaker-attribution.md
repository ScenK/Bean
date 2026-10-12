# Chatops turns carry the speaker; memories belong to the owner

One Bean (one `~/.bean`, one memory store) answers everyone who reaches the Teams/Discord bot —
Teams Store installs, shared channels, group chats. Before this, user turns reached `converse()`
unnamed while memories said "facts about the user", so the model addressed every coworker as the
owner (and treated their instructions as the owner's).

- `bot.ts` passes `speaker: msg.fromName` to `converse()` and stores user turns as
  `speakerLine(fromName, text)` → `[Name]: text` (brackets stripped from the name so it can't fake
  a second speaker).
- With `speaker` set, `converse()` adds the constant `SHARED_CHAT_NOTE` to the leading system
  message (constant per surface, so prompt caching holds) and frames memories as
  "about your owner". The desktop chat omits `speaker` and is unchanged.
- `latestUserText` stays the raw text: memory ranking, `remember` citation and the
  `propose_delegate` instruction fallback must not see the `[Name]:` prefix.

Open (not fixed here): any chatops speaker can still call `remember`/`forget` on the owner's store.
