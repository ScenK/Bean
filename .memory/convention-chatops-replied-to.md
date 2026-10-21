# Chatops replied-to context (`IncomingMessage.repliedTo`)

A surface may attach the message a turn replies to. Core (`bot.ts onMessage`, after the role and
command gates) treats it like the ambient block — see
[convention-chatops-addressing-and-ambient](convention-chatops-addressing-and-ambient.md):

- **Context, never input.** `repliedTo` never feeds `msg.text`/`typedText`, command parsing, or
  `remember` citation checks, and never changes the role — a guest quoting the owner still gets
  guest tools. Quoted "remember …" or `/new` does nothing.
- **Framed + saved once.** `formatRepliedBlock()` (`ambient.ts`) frames it as information only,
  labels Bean's own messages "you (Bean)", `> `-prefixes every quoted line so the text can't forge
  framing, and adds `[…truncated]` when the surface cut it. It's appended after stored history and
  the ambient block, before the speaker's turn, and saved. The block has **no "now" anchor** on
  purpose: it must be byte-identical across replies so an exact-content match against history
  dedupes it — don't add a current-time line.
- **`unavailable`** adds `REPLIED_UNAVAILABLE` to the history passed to both model hops (the
  chat-skill second hop re-reads the store, so it's appended there too) and is never saved.
- **Discord** (`packages/discord/src/replied-to.ts`) resolves `message.reference` before
  `startThread` (the thread's history starts empty). Same channel only; a forward uses its
  snapshot (author unknown, no origin fetch). A Bean chunk is stitched from `chatops_chunks`
  siblings — contiguous, nearest first, each re-checked as Bean-authored, fetch- and 6k-char-capped.
