# Bean Discord Adapter (`@bean/discord`) — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with skang)
**Scope:** Personal single-user testbed for the chat-bot brain shipped in the Teams POC
(`docs/superpowers/specs/2026-07-10-teams-bot-design.md`), built on the same `teams-bot` branch.

## Goal

Let the owner talk to Bean personally over Discord — in a private server channel via @mention
and in DMs — with the same chat + confirm-first delegate-run behavior as the Teams bot, so the
flow can be exercised end-to-end solo before the Teams app is rolled out to the work group.

Decisions made during brainstorming:

- **Approach:** promote the transport-agnostic bot brain from `@bean/teams` into `@bean/core`
  (`chatops` module), then add a thin `@bean/discord` adapter. Both adapters depend on core;
  neither depends on the other.
- **Surfaces:** both — guild channels (mention-gated) and DMs (mention-free).
- **Authorization:** allowlist-only. Events from any Discord user id not in
  `allowedUserIds` are silently ignored (messages AND component interactions).
- **No tunnel:** Discord's gateway is an outbound WebSocket; no public endpoint, no Azure,
  no IT approval.

## Part 1 — Refactor: chatops promotion to `@bean/core`

Move, verbatim (no logic changes), from `packages/teams/src/` to `packages/core/src/chatops/`:

| File | Contents |
|---|---|
| `bot.ts` | `buildTeamsBot`, `TeamsBotDeps`, `IncomingMessage`, `CardAction`, `BotEffects` |
| `conversation.ts` | `ConversationStore` |
| `proposals.ts` | `ProposalStore`, `PendingProposal` |
| `runs.ts` | `RunRegistry`, `RunEvents`, `RunDelegateFn` |
| `resolve.ts` | `resolveCliModel`, `memoryUpdatesFor`, `CliModelChoice` |

Their five test files move to `packages/core/__test__/` (prefixed `chatops-`, e.g.
`chatops-bot.test.ts`). Core's barrel (`index.ts`) re-exports all of it. Imports inside the
moved files change from `"@bean/core"` to relative `"../<module>.js"` / `"./<sibling>.js"`
paths as needed; `@bean/teams` (`cards.ts` untouched, `server.ts` imports) switches from
`"./bot.js"` etc. to `"@bean/core"`.

Notes:

- `cards.ts` stays in `@bean/teams` — Adaptive Cards are Teams presentation.
- Model-memory keys stay literally `teams:cli` / `teams:model:<cli>`: they are persisted
  user state in `~/.bean/model-memory.json`; renaming would orphan values. `resolve.ts`
  gains a comment stating the historical key name is intentionally shared by all chat
  adapters (Discord warming the same last-used defaults as Teams is desirable).
- `buildTeamsBot` / `TeamsBotDeps` keep their names for now. Renaming to transport-neutral
  names (`buildChatBot`) is an explicitly-deferred cleanup — zero behavior for churn in a
  just-reviewed package.
- Gate for this part alone: full suite green (`pnpm test && pnpm typecheck`), coverage
  carried by the moved tests.

## Part 2 — New package `@bean/discord`

```
packages/discord/
  src/
    discord-config.ts   # pure loader for ~/.bean/discord.json
    components.ts       # pure builders: embeds + selects + buttons (proposal/running/finished)
    chunk.ts            # pure: split long text for Discord's 2000-char message limit
    server.ts           # impure wiring: discord.js gateway client → chatops handlers
  __test__/             # discord-config, components, chunk (server untested, mirrors teams)
  README.md             # portal setup + manual checklist
```

Dependencies: `@bean/core` (workspace), `discord.js` (v14). Same scripts as the other
packages (`build`/`test`/`typecheck`/`start`).

### Config — `~/.bean/discord.json`

```json
{ "botToken": "...", "allowedUserIds": ["<discord user id>"] }
```

`discord-config.ts` mirrors `teams-config.ts` conventions: missing file throws with a setup
hint pointing at the README; invalid JSON throws; empty `botToken` or empty
`allowedUserIds` throws (an empty allowlist would make the bot ignore everyone — fail fast
instead).

### Message flow

- Gateway intents: `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent`
  (Message Content must also be enabled in the developer portal).
- **Guild message:** ignored unless the bot user is mentioned; mention stripped from the
  text; `conversationId` = channel id.
- **DM:** every message counts; `conversationId` = DM channel id.
- **Allowlist:** author id not in `allowedUserIds` → event dropped silently (messages and
  interactions both). The bot's own messages are ignored (standard bot-loop guard).
- The stripped text feeds `bot.onMessage` with the same `IncomingMessage` shape as Teams.

### Proposal UX (components.ts)

- **Proposal message:** one embed (title "Bean proposes a delegate run", fields for project
  and optional skill, description = verbatim instruction) + two select menus (CLI, model —
  pre-selected to the resolved defaults, same option-building inputs as `proposalCard`) +
  Run / Cancel buttons.
- **customId contract:** `bean:<action>:<id>` — `bean:confirm:<proposalId>`,
  `bean:cancel-proposal:<proposalId>`, `bean:cancel-run:<proposalId>`,
  `bean:cli:<proposalId>`, `bean:model:<proposalId>`. `server.ts` parses these and maps to
  the existing `CardAction` value shape (`beanAction`, `proposalId`, `cli`, `model`).
  Note `cancel-run` carries the proposalId; server.ts resolves it to the projectPath it
  cached when the run started (see state below).
- **Running / finished states:** embed variants matching the Teams cards (running shows
  "started by", throttled tail line in a code block, Cancel-run button; finished shows the
  outcome, no components).

### BotEffects mapping (server.ts)

- `reply` / `post` → `channel.send`, long text split by `chunk.ts` (2000-char limit, split
  on line boundaries, hard-split a single over-long line).
- `postCard` → send embed+components message, return its message id.
- `updateCard(activityId, …)` → fetch + `message.edit` by id. The teams `BotEffects.updateCard`
  takes an opaque card `object`; `components.ts` builders return the discord.js
  message-options shape under that `object` type — the adapter owns both ends, same as Teams.
- **Adapter-local state (the only state in server.ts):** a `Map<proposalMessageId, {cli?, model?}>`
  caching the latest select-menu choices (Discord delivers each select change as its own
  interaction), plus a `Map<proposalMessageId, projectPath>` recorded at confirm for
  cancel-run resolution. Entries are deleted when the proposal resolves. Select and button
  interactions are acked with `deferUpdate()` inside Discord's 3-second window before any
  slow work.

### Error handling

Startup: config or login failure → process exits with a clear message. Runtime:
`client.on("error")` logs and continues; a thrown handler error is caught per-event, logged,
and answered with "Something went wrong" in-channel where a context exists (chatops `bot.ts`
already wraps `onMessage` internally). Delegate result/error/cancel messaging is unchanged
chatops behavior.

### Testing

- Pure units: `discord-config` (four cases mirroring teams-config), `components` (customId
  contract, verbatim instruction, pre-selection, finished-has-no-components), `chunk`
  (under-limit passthrough, line-boundary split, over-long single line).
- Moved chatops tests keep covering the brain from core.
- `server.ts` untested (impure wiring; same status as the other two servers). Gate:
  `pnpm test && pnpm typecheck` across all four packages.
- README manual checklist: bot online, DM hello, guild @mention hello, proposal embed with
  selects, run → tail edits → result posted (chunked if long), busy-project refusal, cancel,
  expiry, non-allowlisted user ignored.

## Out of scope

- Renaming `buildTeamsBot`/`TeamsBotDeps` (deferred cleanup).
- Slash commands, threads, multi-user support, persistent state, attachment-based long
  results (chunking is enough for the POC).
- Any change to the Teams adapter beyond import-path updates from the move.
