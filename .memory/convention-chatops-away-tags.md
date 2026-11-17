# Away mode: owner-tag capture (#904)

While `away on` for a surface (#903, `chatops/away.ts`), a message that **explicitly tags the
owner** gets one row in `chatops_away_captures` and then one fixed, code-built line in the same
conversation (`awayLine`: owner away, the reason, "recorded"). One path, `awayTag` in `bot.ts`:
`onAmbient` runs it for un-addressed chatter; adapters call `bot.onAwayTag` for messages addressed
to Bean (non-DM), so tagging Bean **and** the owner gets the normal answer plus the record + line.

- **What counts as a tag** is the adapter's job (`AmbientLine.taggedIds`): Discord = literal
  `<@id>` in the content outside `>`/`>>>` quotes and code spans (`taggedUserIds`) — never a reply
  ping (not in content) or a forward (empty content); Teams = `29:` user mention entities (a
  quote's preview carries none). Plain names, role/`@everyone` tags, bot authors and the owner
  (by `roleOf`, either id form) never trigger.
- **Owner match** = configured `ownerId` + the ids the catalog saw for it
  (`ConversationCatalog.ownerIds`; Teams config may hold the AAD id while mentions carry `29:`).
  An AAD-configured owner who never DMed the bot has no `29:` row yet, so tags don't match.
- **Record before reply**: insert first (`INSERT OR IGNORE`, unique per surface+conversation+
  message — a redelivery posts nothing). A storage failure still posts the away line but **without**
  the recorded claim. The post never pings (Discord `allowedMentions: { parse: [] }`, Teams plain
  text) and never rejects.
- **Private**: no note, no search, no tool or command reads the table — a test fails if any file
  but `chatops/away.ts` and `db.ts` names it. The return summary (#905) is its only reader.
- **Return summary (#905)**: `closeAway` reads one period's rows (by `away_since`) and clears the
  state with no await between; `awaySummary` is pure code (no model): grouped by conversation,
  ≤20 entries + "and N more". Captured text goes in a one-line, clipped inline code span and names
  lose markdown, so a tagger can't forge headers or entries. `away off` in the owner's DM replies
  with it; `closeAwayToOwnerDm` (for a toggle made elsewhere) queues it as a channel-less,
  user-less outbox message — the owner's DM only; the drains never fall back to a channel.
  Rows are kept after the summary (no retention sweep yet).
- **Known gap**: a conversation bound to a live session bypasses ambient and addressed paths
  (every message is a steer), so tags there are not captured. Personal 1:1 chats never capture.
