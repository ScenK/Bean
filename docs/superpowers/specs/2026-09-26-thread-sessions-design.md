# Thread sessions — design

Date: 2026-09-26. Status: agreed, not started. Hand-off spec for the implementing session.
Delete this file after the work merges (repo convention, see git log for `docs/superpowers`).

## Why

Bean's real usage is now remote assistant work (Discord/Teams, routines, Jira/Gmail via
Claude Code connectors), not just launching coding runs. Two things are missing:

1. **Multiple parallel sessions per channel.** Today one channel = one `chatops_turns`
   history, reset with `/new`. PR #153 (`feat-chatops-resume`, not merged) tried a text
   `/sessions` + `/resume <n>` list. Rejected: it re-implements a sidebar as text and can't
   match Claude Code's resume picker or Claude Desktop's session list. **Close #153.**
2. **Follow-ups on delegate output lose the agent's context.** Every delegate is a fresh
   `claude -p`; asking "who owns item 3" after a Jira report re-queries from zero.

The platforms already have the sidebar: Discord threads, Teams channel posts. Use them.

## Model

```
one thread (Discord) / one channel post (Teams)
  = one session
  = one chatops_turns history (already true: conversationId is the thread/post id)
  + one claude session id (new: for `claude -p --resume`)
```

Discord: `message.channelId` inside a thread is the thread id, so per-thread histories
already work. Teams: channel conversation ids carry `;messageid=<root post>`, so per-post
histories already work. Nothing to build for listing, switching, searching or archiving.

DMs (Discord) and group chats / personal chats (Teams) have no threads. They stay
single-session, exactly as today. Multi-session usage happens in a server channel / Team
channel. This is a platform limit, not something to work around.

Suggested Discord layout (config, not code):

```
Category "Bean"
├─ #bean       text channel — entry point; each top-level @mention opens a session thread
├─ #routines   text channel — routine digests, one thread per run (or per routine)
└─ DM          quick single-session questions
```

## User flow

| Action | User | Bean |
|---|---|---|
| New session | `@Bean …` as a top-level message in `#bean` | `startThread` on that message; thread name from the brain (auto-title, like Claude Code); first reply lands in the thread |
| Continue | type in the thread, no @ needed | a Bean-opened thread counts as addressed |
| Delegate | confirm the card as today | card, tail and result all inside the thread; thread id ↔ claude session id stored |
| Follow-up on a result | ask in the thread | delegate runs with `--resume <session id>`; the agent still has the report |
| Old session | open the thread from the sidebar / search | archived threads unarchive on post |
| Parallel work | another top-level message in `#bean` | another thread |

Teams channel: identical, except the **user** creates the session by starting a new post
(Teams gives the post its own conversation id; Bean must not create posts). Every reply
inside the post still needs `@Bean` unless the manifest gets RSC
`ChannelMessage.Read.Group` (same constraint ambient and live sessions already have).

Routines: each run posts into its own thread (Discord) / root post (Teams, already the case
with a bare channel id sink). Asking a question in that thread resumes the claude session
that produced the report. Routine output threads and interactive sessions are the same thing.

`/new` keeps its current meaning in DMs. In channels it becomes unnecessary (post a new
top-level message instead); leave it working, don't extend it.

## Implementation — three steps, in order

### Step 1 — Discord opens a thread per top-level mention

- `packages/discord/src/server.ts`: on an addressed message whose channel is a plain text
  channel (not a thread, not a DM), `message.startThread({ name, autoArchiveDuration })`
  before dispatching to `bot.onMessage`, and dispatch with `conversationId = thread.id`.
  Reply/post effects for that turn must target the thread, not the parent.
- Thread name: ask the brain for a short title from the first message (one cheap chat call,
  ≤ 100 chars, fall back to a clipped first line). Keep it simple; users can rename in Discord.
- `packages/core/src/chatops/bot.ts` (or the Discord surface's addressing check): a message
  inside a thread the bot created is addressed even without @mention/reply. The live-session
  capture check (`liveSessions.has(channelId)`) is the same shape and the same place.
  Persist "Bean-owned thread ids" (bean.db table, see step 3's table) so this survives restart;
  a cheaper first cut is "thread whose owner is the bot user" from the Discord API.
- Ambient: a Bean-owned thread has no ambient chatter concept; skip the `fetchRecent` path there.
- Discord limits to respect: 1000 active threads per guild (archived don't count), 100-char
  names. Auto-archive frees active slots; don't add a reaper.

### Step 2 — routines post into a thread per run (Discord)

- `outbox.ts` consumers in `packages/discord/src/server.ts`: when the sink channel is a text
  channel, create a thread named `<routine> · <date>` and post the digest inside. When the
  sink is already a thread id (current user config), post there as today.
- Teams: no change (bare channel id already yields a new root post per run).

### Step 3 — `--resume` (the delegate context fix)

- `packages/core/src/delegate.ts`: `DelegateRequest.resume?: string`; claude branch adds
  `--resume <id>`. Capture `session_id` from the stream-json `system`/`init` event and hand
  it to `onDone` (extend `DelegateCallbacks` or the result shape).
- `packages/core/src/db.ts` + new store: `thread_sessions(conversation_id PRIMARY KEY,
  claude_session_id, updated_at)`. New table, so no `ALTER TABLE` dance needed; follow
  `convention-bean-db-column-additions` anyway if a column is added later.
- `packages/core/src/chatops/bot.ts` `startRun`: if the conversation has a stored session id
  and the CLI is `claude`, set `resume`. On `onDone`, store the returned session id.
  Non-claude CLIs: no resume, unchanged.
- `converse()`'s `propose_delegate` is untouched: the brain still decides "needs the agent",
  the bot just adds `resume` at launch. Project stays optional (scratch workspace).
- Confirm-first: keep the card on every delegate for now. Dropping the card for follow-ups
  inside a session thread is a later, separate decision.
- Routines: `DelegateStepRequest` gets an optional `resume` too, so a routine's thread can
  be resumed by a follow-up. Do this only after steps 1–2 are proven in daily use.

## Explicitly out of scope

- Claude as the brain / Claude API + MCP (`converse()` stays OpenAI). Connector auth lives
  in Claude Code, not reusable from the API.
- Reworking live sessions (`live-session.ts`, `chatops/live-sessions.ts`). They stay the
  streaming war-room tool; the fragile flush/rollover code must not be touched by this work.
- Changing `--dangerously-skip-permissions`. If Gmail-send-class actions become a worry,
  the knob is claude's `--disallowedTools` behind one config field — not part of this.
- Shrinking `behaviorInstructions` in `converse()`. Revisit after a few weeks of use to see
  which hand-off branches are dead.
- Any session list / resume-by-number UI. The platform sidebar is the UI.

## Verification

- `pnpm test && pnpm typecheck` green.
- Manual, real Discord bot: top-level mention → thread created and named → reply lands
  inside → untagged follow-up in the thread gets a turn → delegate card + result in the
  thread → follow-up question resumes (check the claude `session_id` matches) → bot restart
  → thread still addressed.
- Teams: new channel post → replies stay under it (already true; regression check only).
