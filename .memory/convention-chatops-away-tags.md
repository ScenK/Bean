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
- **Tray toggle (#906)**: the desktop tray's Chat Bots submenu has an "Away on <bot>" checkbox
  per surface (`app/src/chatops-tray-menu.ts`), local core only (nothing in `REMOTE_OPS`; the DM
  command covers a remote core). It reads bean.db on every menu open, is independent of the bot
  process (start/stop never touches it), turns on with no reason (leaving a period already on
  alone), and off goes through `closeAwayToOwnerDm`.
- **Suggestion (#907)**: after the away line, and only with config `webSearch` on, `awaySuggestion`
  makes one tool-less call (built-in web search only, 30 s timeout, no retry) whose input is a fixed
  instruction plus the fenced tagged text — never persona, memories, notes, history, the owner's
  name or reason (tested). The post is a second message: the code-built `awaySuggestionPrefix`
  line, then the model text clipped to 600 chars; `NO_SUGGESTION`, timeout or failure posts nothing.
  Cap: 100 calls per surface per day in `chatops_away_suggestions` (claimed before the call).
- **Prepare (#909)**: with a read-only CLI (claude/codex) and an executor (`awayPrepareRun`, the
  servers pass `runDelegate`), the suggestion call also offers `prepare(project, brief)` — `project`
  an enum of registered names + `scratch`, re-checked in code (unknown → scratch) — and runs even
  with `webSearch` off (its text discarded). A suggestion text naming a project is dropped. Claims go
  to `chatops_away_prepares` (1:1 with the capture key; read only by `away.ts`, tested) under
  persisted caps (`AWAY_PREPARE_LIMITS`; over one = `not_prepared` with the reason). `away-prepare.ts`
  runs one per surface: `mode: "plan"`, fresh, brief + tagged text fenced as data, 20-min timeout,
  no retry; every outcome is written to the row only — never the conversation, history, cards or
  thread session. `setOff` cancels queued + running rows (the runner polls its row every 5 s, so a
  tray toggle in another process stops it); bot start and SIGTERM mark a running row interrupted.
  The summary adds each plan's first 3 lines (inline code, clipped) and a `cd … && <resume>` receipt.
- **Known gap**: a conversation bound to a live session bypasses ambient and addressed paths
  (every message is a steer), so tags there are not captured. Personal 1:1 chats never capture.
